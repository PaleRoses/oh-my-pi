// Integration tests for broker-owned schedules: real broker + real timers.
// The broker is spawned automatically by the client (unix-socket RPC), so
// these exercises are cross-process end to end.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { parseDaemonWireRequest } from "../../src/launch/protocol";
import type { ScheduleFireNotification } from "../../src/launch/protocol";
import { buildScheduleSpec } from "../../src/tools/hub/schedule";

const OWNER = "session-1";

function waitFor(predicate: () => boolean, deadlineMs: number): Promise<void> {
	return new Promise(resolve => {
		const deadline = Date.now() + deadlineMs;
		const poll = async (): Promise<void> => {
			if (predicate() || Date.now() >= deadline) {
				resolve();
				return;
			}
			await Bun.sleep(25);
			await poll();
		};
		void poll();
	});
}

async function shutdown(client: DaemonBrokerClient): Promise<void> {
	await client.request({ op: "shutdown" }).catch(() => undefined);
	client.close();
}

describe("daemon broker schedules", () => {
	it("delivers schedule fires to a subscribed client", async () => {
		using tempDir = TempDir.createSync("@omp-schedule-fire-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const fires: ScheduleFireNotification[] = [];
		let unregister: (() => void) | undefined;
		try {
			unregister = client.onScheduleFire(OWNER, notification => {
				fires.push(notification);
			});
			const set = await client.request({
				op: "schedule-set",
				spec: { name: "beat", message: "heartbeat", sessionId: OWNER, everyMs: 150 },
			});
			if (set.op !== "schedule-set") throw new Error(`unexpected result: ${set.op}`);
			expect(set.schedule.name).toBe("beat");

			await waitFor(() => fires.length > 0, 5_000);
			expect(fires.length).toBeGreaterThan(0);
			expect(fires[0]?.schedule.name).toBe("beat");
			expect(fires[0]?.schedule.sessionId).toBe(OWNER);
			expect(fires[0]?.schedule.message).toBe("heartbeat");
			expect(fires[0]?.schedule.firedCount).toBe(1);
			expect(fires[0]?.schedule.everyMs).toBe(150);
			expect(fires[0]?.firedAt).toBeGreaterThan(0);

			// Repeating schedule keeps firing and stays listed.
			const listed = await client.request({ op: "schedule-list" });
			if (listed.op !== "schedule-list") throw new Error(`unexpected result: ${listed.op}`);
			expect(listed.schedules.map(schedule => schedule.name)).toEqual(["beat"]);
		} finally {
			unregister?.();
			await shutdown(client);
		}
	}, 20_000);

	it("persists schedules across broker restarts and re-arms them", async () => {
		using tempDir = TempDir.createSync("@omp-schedule-persist-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const firstClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const firstFires: ScheduleFireNotification[] = [];
		let firstUnregister: (() => void) | undefined;
		try {
			firstUnregister = firstClient.onScheduleFire(OWNER, notification => {
				firstFires.push(notification);
			});
			const set = await firstClient.request({
				op: "schedule-set",
				spec: { name: "morning", message: "re-enter", sessionId: OWNER, everyMs: 150 },
			});
			if (set.op !== "schedule-set") throw new Error(`unexpected result: ${set.op}`);
			await waitFor(() => firstFires.length >= 2, 5_000);
			expect(firstFires.length).toBeGreaterThanOrEqual(2);

			const schedulesPath = path.join(runtimeDir, "schedules.json");
			const persisted = await Bun.file(schedulesPath).json();
			expect(persisted).toHaveLength(1);
			expect(persisted[0]?.name).toBe("morning");
			expect(persisted[0]?.firedCount).toBeGreaterThanOrEqual(2);
		} finally {
			firstUnregister?.();
			await shutdown(firstClient);
		}

		// Let the armed due time lapse so recovery must fire the past-due schedule.
		await Bun.sleep(400);

		const secondClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const secondFires: ScheduleFireNotification[] = [];
		let secondUnregister: (() => void) | undefined;
		try {
			secondUnregister = secondClient.onScheduleFire(OWNER, notification => {
				secondFires.push(notification);
			});
			// The recovered broker fires the past-due schedule immediately once
			// (delivered as a replay since the owner subscribes after recovery),
			// then re-arms from the due time.
			await waitFor(() => secondFires.length > 0, 5_000);
			expect(secondFires.length).toBeGreaterThan(0);
			expect(secondFires[0]?.schedule.name).toBe("morning");
			expect(secondFires[0]?.schedule.firedCount).toBeGreaterThanOrEqual(3);

			const listed = await secondClient.request({ op: "schedule-list" });
			if (listed.op !== "schedule-list") throw new Error(`unexpected result: ${listed.op}`);
			expect(listed.schedules).toHaveLength(1);
			expect(listed.schedules[0]?.name).toBe("morning");
			expect(listed.schedules[0]?.message).toBe("re-enter");
			expect(listed.schedules[0]?.nextDueAt).toBeGreaterThan(Date.now());
		} finally {
			secondUnregister?.();
			await shutdown(secondClient);
		}
	}, 30_000);

	it("cancels whileDaemon schedules when the daemon settles and when the guard is not live", async () => {
		using tempDir = TempDir.createSync("@omp-schedule-while-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const fires: ScheduleFireNotification[] = [];
		let unregister: (() => void) | undefined;
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "watcher",
					application: process.execPath,
					args: ["-e", "process.stdin.resume()"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);
			expect(started.daemon.state).toBe("running");

			unregister = client.onScheduleFire(OWNER, notification => {
				fires.push(notification);
			});
			const set = await client.request({
				op: "schedule-set",
				spec: { name: "poke", message: "still there", sessionId: OWNER, everyMs: 150, whileDaemon: "watcher" },
			});
			if (set.op !== "schedule-set") throw new Error(`unexpected result: ${set.op}`);
			await waitFor(() => fires.length > 0, 5_000);
			expect(fires.length).toBeGreaterThan(0);

			// Stopping the guarded daemon settles it → the schedule is cancelled.
			await client.request({ op: "stop", name: "watcher", timeoutMs: 2_000 });
			const afterStop = await client.request({ op: "schedule-list" });
			if (afterStop.op !== "schedule-list") throw new Error(`unexpected result: ${afterStop.op}`);
			expect(afterStop.schedules.find(schedule => schedule.name === "poke")).toBeUndefined();

			const settledCount = fires.length;
			await Bun.sleep(500);
			expect(fires.length).toBe(settledCount);

			// A guard naming a daemon that never ran cancels at fire time instead
			// of firing.
			const ghost = await client.request({
				op: "schedule-set",
				spec: { name: "ghost-poke", message: "never", sessionId: OWNER, everyMs: 120, whileDaemon: "ghost" },
			});
			if (ghost.op !== "schedule-set") throw new Error(`unexpected result: ${ghost.op}`);
			await Bun.sleep(500);
			const afterGhost = await client.request({ op: "schedule-list" });
			if (afterGhost.op !== "schedule-list") throw new Error(`unexpected result: ${afterGhost.op}`);
			expect(afterGhost.schedules.find(schedule => schedule.name === "ghost-poke")).toBeUndefined();
			expect(fires.length).toBe(settledCount);
		} finally {
			unregister?.();
			await client.request({ op: "stop", name: "watcher", timeoutMs: 2_000 }).catch(() => undefined);
			await shutdown(client);
		}
	}, 30_000);

	it("replays only the latest undelivered fire per schedule name on reconnect", async () => {
		using tempDir = TempDir.createSync("@omp-schedule-replay-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		try {
			// No subscriber is registered: every fire while unsubscribed is
			// retained (latest per name) for replay.
			const set = await client.request({
				op: "schedule-set",
				spec: { name: "pager", message: "wake", sessionId: OWNER, everyMs: 120 },
			});
			if (set.op !== "schedule-set") throw new Error(`unexpected result: ${set.op}`);
			await Bun.sleep(600);

			const fires: ScheduleFireNotification[] = [];
			let unregister: (() => void) | undefined;
			unregister = client.onScheduleFire(OWNER, notification => {
				fires.push(notification);
			});
			// Subscribing publishes the owner; the broker replays the single
			// latest pending fire, then live fires continue.
			await waitFor(() => fires.length > 0, 5_000);
			expect(fires.length).toBeGreaterThan(0);
			expect(fires[0]?.schedule.name).toBe("pager");
			expect(fires[0]?.schedule.firedCount).toBeGreaterThanOrEqual(4);

			// Exactly one replayed catch-up fire, then strictly increasing live
			// fires — never a duplicate of an earlier missed beat.
			await waitFor(() => fires.length >= 3, 5_000);
			for (let index = 1; index < fires.length; index++) {
				expect(fires[index]?.schedule.firedCount).toBe((fires[index - 1]?.schedule.firedCount ?? 0) + 1);
			}
			unregister();
		} finally {
			await shutdown(client);
		}
	}, 20_000);

	it("rejects clearing an unknown schedule", async () => {
		using tempDir = TempDir.createSync("@omp-schedule-clear-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		try {
			await expect(client.request({ op: "schedule-clear", name: "ghost" })).rejects.toThrow(/Unknown schedule ghost/);
		} finally {
			await shutdown(client);
		}
	}, 20_000);
});

describe("hub schedule op validation", () => {
	it("requires exactly one of at or every for a set", () => {
		expect(() => buildScheduleSpec({ op: "schedule", name: "x", message: "m" }, OWNER)).toThrow(/exactly one of at or every/);
		expect(() =>
			buildScheduleSpec(
				{ op: "schedule", name: "x", message: "m", at: "2026-08-06T09:00:00", every: "20m" },
				OWNER,
			),
		).toThrow(/exactly one of at or every/);
	});

	it("parses at and every into a broker spec with the session id", () => {
		const atSpec = buildScheduleSpec({ op: "schedule", name: "x", message: "m", at: "2026-08-06T09:00:00Z" }, OWNER);
		expect(atSpec).toEqual({
			name: "x",
			message: "m",
			sessionId: OWNER,
			at: Date.parse("2026-08-06T09:00:00Z"),
			everyMs: undefined,
			whileDaemon: undefined,
		});
		const everySpec = buildScheduleSpec(
			{ op: "schedule", name: "x", message: "m", every: "2h", while: "web" },
			OWNER,
		);
		expect(everySpec).toEqual({
			name: "x",
			message: "m",
			sessionId: OWNER,
			at: undefined,
			everyMs: 2 * 3_600_000,
			whileDaemon: "web",
		});
	});

	it("rejects malformed at datetimes and durations and missing message/name", () => {
		expect(() =>
			buildScheduleSpec({ op: "schedule", name: "x", message: "m", at: "not-a-date" }, OWNER),
		).toThrow(/ISO-8601 datetime/);
		expect(() =>
			buildScheduleSpec({ op: "schedule", name: "x", message: "m", every: "fortnight" }, OWNER),
		).toThrow(/duration like/);
		expect(() => buildScheduleSpec({ op: "schedule", name: "x", every: "20m" }, OWNER)).toThrow(/requires message/);
		expect(() => buildScheduleSpec({ op: "schedule", message: "m", every: "20m" }, OWNER)).toThrow(/requires name/);
	});

	it("rejects a schedule-set spec with neither nor both of at/everyMs at the protocol boundary", () => {
		expect(() =>
			parseDaemonWireRequest({
				id: "r1",
				token: "t",
				operation: { op: "schedule-set", spec: { name: "x", message: "m", sessionId: OWNER } },
			}),
		).toThrow(/exactly one of at or everyMs/);
		expect(() =>
			parseDaemonWireRequest({
				id: "r1",
				token: "t",
				operation: {
					op: "schedule-set",
					spec: { name: "x", message: "m", sessionId: OWNER, at: 1, everyMs: 2 },
				},
			}),
		).toThrow(/exactly one of at or everyMs/);
	});
});
