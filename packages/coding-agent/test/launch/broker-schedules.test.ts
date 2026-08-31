// Broker-owned schedule integration tests. Most exercise cross-process RPC;
// the retry liveness regression runs an in-process broker under a fake clock.
import { describe, expect, it, setSystemTime, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	parseDaemonWireRequest,
	parseScheduleSnapshot,
	type ScheduleFireNotification,
} from "../../src/launch/protocol";
import { buildScheduleSpec } from "../../src/tools/hub/schedule";

const OWNER = "session-1";
const SECOND_OWNER = "session-2";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, idleGraceMs: number): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = String(idleGraceMs);
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for broker condition");
		await Bun.sleep(25);
	}
}

async function shutdown(client: DaemonBrokerClient): Promise<void> {
	await client.request({ op: "shutdown" }).catch(() => undefined);
	client.close();
}

async function brokerStopped(projectDir: string, runtimeDir: string): Promise<boolean> {
	try {
		await fs.stat(daemonBrokerEndpoint(projectDir, runtimeDir));
		return false;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
		throw error;
	}
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

	it("recovers legacy array snapshots, lists them, and delivers their past-due fire", async () => {
		using tempDir = TempDir.createSync("@omp-schedule-legacy-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		await fs.mkdir(runtimeDir);
		await fs.writeFile(
			path.join(runtimeDir, "schedules.json"),
			JSON.stringify([
				{
					name: "legacy",
					message: "array snapshot",
					sessionId: OWNER,
					everyMs: 60_000,
					nextDueAt: Date.now() - 1_000,
					firedCount: 4,
				},
			]),
			"utf8",
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const fires: ScheduleFireNotification[] = [];
		let unregister: (() => void) | undefined;
		try {
			const listed = await client.request({ op: "schedule-list" });
			if (listed.op !== "schedule-list") throw new Error(`unexpected result: ${listed.op}`);
			expect(listed.schedules).toHaveLength(1);
			expect(listed.schedules[0]).toMatchObject({
				name: "legacy",
				message: "array snapshot",
				sessionId: OWNER,
				firedCount: 5,
			});
			expect(listed.schedules[0]?.nextDueAt).toBeGreaterThan(Date.now());

			unregister = client.onScheduleFire(OWNER, notification => {
				fires.push(notification);
			});
			await waitFor(() => fires.length === 1, 5_000);
			expect(fires[0]).toMatchObject({
				schedule: { name: "legacy", sessionId: OWNER, firedCount: 5 },
			});
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
			expect(persisted.schedules).toHaveLength(1);
			expect(persisted.schedules[0]?.name).toBe("morning");
			expect(persisted.schedules[0]?.firedCount).toBeGreaterThanOrEqual(2);
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
			const recoveredFire = secondFires[0];
			if (!recoveredFire) throw new Error("Expected recovered schedule fire");
			expect(recoveredFire.schedule.name).toBe("morning");
			expect(recoveredFire.schedule.firedCount).toBeGreaterThanOrEqual(3);
			expect(recoveredFire.schedule.nextDueAt).toBeGreaterThan(recoveredFire.firedAt);

			const listed = await secondClient.request({ op: "schedule-list" });
			if (listed.op !== "schedule-list") throw new Error(`unexpected result: ${listed.op}`);
			expect(listed.schedules).toHaveLength(1);
			expect(listed.schedules[0]?.name).toBe("morning");
			expect(listed.schedules[0]?.message).toBe("re-enter");
			expect(listed.schedules[0]?.nextDueAt).toBeGreaterThanOrEqual(recoveredFire.schedule.nextDueAt);
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

	it("replays unacknowledged fires across disconnects and broker restarts until a session accepts them", async () => {
		using tempDir = TempDir.createSync("@omp-schedule-ack-replay-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
		const firstRejected: ScheduleFireNotification[] = [];
		let firstUnregister: (() => void) | undefined;
		try {
			firstUnregister = first.onScheduleFire(OWNER, notification => {
				firstRejected.push(notification);
				throw new Error("Session rejected schedule fire");
			});
			const set = await first.request({
				op: "schedule-set",
				spec: { name: "durable", message: "wake", sessionId: OWNER, at: Date.now() + 125 },
			});
			if (set.op !== "schedule-set") throw new Error("Unexpected schedule-set result");
			await waitFor(() => firstRejected.length === 1, 5_000);
		} finally {
			first.close();
			firstUnregister?.();
		}
		const firstFire = firstRejected[0];
		if (!firstFire) throw new Error("Expected rejected schedule fire");
		await waitFor(() => brokerStopped(projectDir, runtimeDir), 5_000);

		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
		const secondRejected: ScheduleFireNotification[] = [];
		let secondUnregister: (() => void) | undefined;
		try {
			secondUnregister = second.onScheduleFire(OWNER, notification => {
				secondRejected.push(notification);
				throw new Error("Session rejected replayed schedule fire");
			});
			await waitFor(() => secondRejected.length === 1, 5_000);
		} finally {
			second.close();
			secondUnregister?.();
		}
		const secondFire = secondRejected[0];
		if (!secondFire) throw new Error("Expected replayed schedule fire");
		expect(secondFire.fireId).toBe(firstFire.fireId);
		await waitFor(() => brokerStopped(projectDir, runtimeDir), 5_000);

		const third = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
		const accepted: ScheduleFireNotification[] = [];
		let thirdUnregister: (() => void) | undefined;
		try {
			thirdUnregister = third.onScheduleFire(OWNER, notification => {
				accepted.push(notification);
			});
			await third.request({ op: "ping" });
			await waitFor(() => accepted.length === 1, 5_000);
			const acceptedFire = accepted[0];
			if (!acceptedFire) throw new Error("Expected accepted schedule fire");
			expect(acceptedFire.fireId).toBe(firstFire.fireId);
			await third.request({ op: "ping" });
			await waitFor(async () => {
				const persisted = await Bun.file(path.join(runtimeDir, "schedules.json")).json();
				return Array.isArray(persisted.pendingFires) && persisted.pendingFires.length === 0;
			}, 5_000);
		} finally {
			third.close();
			thirdUnregister?.();
		}
		await waitFor(() => brokerStopped(projectDir, runtimeDir), 5_000);

		const fourth = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
		const afterAcknowledgement: ScheduleFireNotification[] = [];
		let fourthUnregister: (() => void) | undefined;
		try {
			fourthUnregister = fourth.onScheduleFire(OWNER, notification => {
				afterAcknowledgement.push(notification);
			});
			await fourth.request({ op: "ping" });
			await Bun.sleep(300);
			expect(afterAcknowledgement).toHaveLength(0);
		} finally {
			fourthUnregister?.();
			await shutdown(fourth);
		}
	}, 30_000);

	it("withholds a newly due fire until its pending snapshot is durable, then recovers its exact fire id", async () => {
		using tempDir = TempDir.createSync("@omp-schedule-due-write-failure-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const schedulesPath = path.join(runtimeDir, "schedules.json");
		const backupPath = `${schedulesPath}.before-due`;
		await fs.mkdir(projectDir);

		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const prematurelyDelivered: ScheduleFireNotification[] = [];
		let firstUnregister: (() => void) | undefined;
		let firstClosed = false;
		try {
			firstUnregister = first.onScheduleFire(OWNER, notification => {
				prematurelyDelivered.push(notification);
				throw new Error("The failed write must not expose this fire");
			});
			const set = await first.request({
				op: "schedule-set",
				spec: { name: "withheld", message: "durable first", sessionId: OWNER, everyMs: 250 },
			});
			if (set.op !== "schedule-set") throw new Error("Unexpected schedule-set result");
			await waitFor(async () => {
				const persisted = await Bun.file(schedulesPath).json();
				return Array.isArray(persisted.schedules) && persisted.schedules.length === 1;
			}, 5_000);

			await fs.rename(schedulesPath, backupPath);
			await fs.mkdir(schedulesPath);
			await waitFor(async () => {
				const temporary = (await fs.readdir(runtimeDir)).find(
					entry => entry.startsWith("schedules.json.") && entry.endsWith(".tmp"),
				);
				if (!temporary) return false;
				const attempted = await Bun.file(path.join(runtimeDir, temporary)).json();
				return Array.isArray(attempted.pendingFires) && attempted.pendingFires.length === 1;
			}, 5_000);
			expect(prematurelyDelivered).toHaveLength(0);

			const temporary = (await fs.readdir(runtimeDir)).find(
				entry => entry.startsWith("schedules.json.") && entry.endsWith(".tmp"),
			);
			if (!temporary) throw new Error("Expected failed pending schedule snapshot");
			const attempted = await Bun.file(path.join(runtimeDir, temporary)).json();
			const withheldFire = attempted.pendingFires?.[0];
			if (typeof withheldFire?.fireId !== "string") throw new Error("Expected pending fire id");

			firstUnregister?.();
			firstUnregister = undefined;
			first.close();
			firstClosed = true;
			await fs.rm(schedulesPath, { recursive: true });
			await fs.rename(backupPath, schedulesPath);
			await waitFor(async () => {
				const persisted = await Bun.file(schedulesPath).json();
				return persisted.pendingFires?.some((fire: { fireId?: unknown }) => fire.fireId === withheldFire.fireId);
			}, 12_000);

			const control = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			await shutdown(control);
			await waitFor(() => brokerStopped(projectDir, runtimeDir), 5_000);

			const recovered = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const recoveredFires: ScheduleFireNotification[] = [];
			let recoveredUnregister: (() => void) | undefined;
			try {
				recoveredUnregister = recovered.onScheduleFire(OWNER, notification => {
					recoveredFires.push(notification);
					throw new Error("Keep the recovered fire pending for this assertion");
				});
				await waitFor(() => recoveredFires.length > 0, 5_000);
				expect(recoveredFires[0]?.fireId).toBe(withheldFire.fireId);
			} finally {
				recoveredUnregister?.();
				await shutdown(recovered);
			}
		} finally {
			firstUnregister?.();
			if (!firstClosed) await shutdown(first);
		}
	}, 30_000);

	/** A private due candidate must outlive idle grace until its retry writes durably. */
	it("keeps a failed due write alive through its five-second retry after the last client disconnects", async () => {
		using tempDir = TempDir.createSync("@omp-schedule-due-retry-backoff-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		// Construct the client before starting the in-process broker so it writes
		// the broker token, as the ordinary client-spawn harness does.
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
		const broker = startBroker(projectDir, runtimeDir, 1_000);
		const clockStart = Date.now();
		try {
			await client.request({ op: "ping" });
			vi.useFakeTimers();
			setSystemTime(clockStart);
			const set = await client.request({
				op: "schedule-set",
				spec: { name: "retry", message: "durable first", sessionId: OWNER, at: Date.now() + 1 },
			});
			if (set.op !== "schedule-set") throw new Error("Unexpected schedule-set result");

			const firstFailedRename = Promise.withResolvers<void>();
			const successfulRetry = Promise.withResolvers<{ pendingFires?: Array<{ fireId?: unknown }> }>();
			const persistRename = fs.rename;
			let persistenceFails = true;
			const renames = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
				if (persistenceFails) {
					firstFailedRename.resolve();
					throw new Error("forced atomic schedule write failure");
				}
				const snapshot: { pendingFires?: Array<{ fireId?: unknown }> } = JSON.parse(
					await fs.readFile(source, "utf8"),
				);
				await persistRename(source, destination);
				successfulRetry.resolve(snapshot);
			});
			try {
				vi.advanceTimersByTime(1);
				await firstFailedRename.promise;
				for (let attempt = 0; attempt < 10; attempt++) await Promise.resolve();
				expect(renames).toHaveBeenCalledTimes(1);
				const temporary = (await fs.readdir(runtimeDir)).find(
					entry => entry.startsWith("schedules.json.") && entry.endsWith(".tmp"),
				);
				if (!temporary) throw new Error("Expected failed pending schedule snapshot");
				const attempted = await Bun.file(path.join(runtimeDir, temporary)).json();
				const fireId = attempted.pendingFires?.[0]?.fireId;
				if (typeof fireId !== "string") throw new Error("Expected pending fire id");

				// The due time is within idle grace. Once this socket closes, the retry
				// still owns the broker; no new client is allowed to revive it.
				client.close();
				vi.advanceTimersByTime(4_999);
				expect(await brokerStopped(projectDir, runtimeDir)).toBe(false);
				expect(renames).toHaveBeenCalledTimes(1);
				persistenceFails = false;
				vi.advanceTimersByTime(1);
				const retried = await successfulRetry.promise;
				expect(renames).toHaveBeenCalledTimes(2);
				expect(retried.pendingFires?.map(fire => fire.fireId)).toEqual([fireId]);
				const persisted = await Bun.file(path.join(runtimeDir, "schedules.json")).json();
				expect(persisted.pendingFires?.map((fire: { fireId?: unknown }) => fire.fireId)).toEqual([fireId]);
			} finally {
				renames.mockRestore();
			}
		} finally {
			vi.useRealTimers();
			setSystemTime();
			client.close();
			const control = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
			await shutdown(control);
			await broker;
		}
	}, 20_000);

	it("retries a failed durable acknowledgement on its live socket without reexecuting its sink", async () => {
		using tempDir = TempDir.createSync("@omp-schedule-ack-write-failure-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const schedulesPath = path.join(runtimeDir, "schedules.json");
		const backupPath = `${schedulesPath}.before-ack`;
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const accepted: ScheduleFireNotification[] = [];
		let unregister: (() => void) | undefined;
		try {
			unregister = client.onScheduleFire(OWNER, async notification => {
				accepted.push(notification);
				await fs.rename(schedulesPath, backupPath);
				await fs.mkdir(schedulesPath);
			});
			const set = await client.request({
				op: "schedule-set",
				spec: { name: "ack-failure", message: "retain me", sessionId: OWNER, at: Date.now() + 125 },
			});
			if (set.op !== "schedule-set") throw new Error("Unexpected schedule-set result");
			await waitFor(() => accepted.length === 1, 5_000);
			await Bun.sleep(100);
			expect((await fs.stat(schedulesPath)).isDirectory()).toBe(true);

			// The accepted fire remains locally deduplicated while its ACK retries on
			// this same socket. Restoring persistence must drain the durable pending
			// state without requiring a reconnect or another sink execution.
			await fs.rm(schedulesPath, { recursive: true });
			await fs.rename(backupPath, schedulesPath);
			await waitFor(async () => {
				const persisted = await Bun.file(schedulesPath).json();
				return Array.isArray(persisted.pendingFires) && persisted.pendingFires.length === 0;
			}, 5_000);
			await Bun.sleep(300);
			expect(accepted).toHaveLength(1);
		} finally {
			unregister?.();
			await shutdown(client);
		}
	}, 20_000);

	it("isolates same-named schedules and clears by session", async () => {
		using tempDir = TempDir.createSync("@omp-schedule-session-key-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const firstFires: ScheduleFireNotification[] = [];
		const secondFires: ScheduleFireNotification[] = [];
		let firstUnregister: (() => void) | undefined;
		let secondUnregister: (() => void) | undefined;
		try {
			firstUnregister = client.onScheduleFire(OWNER, notification => {
				firstFires.push(notification);
			});
			secondUnregister = client.onScheduleFire(SECOND_OWNER, notification => {
				secondFires.push(notification);
			});
			await client.request({
				op: "schedule-set",
				spec: { name: "shared", message: "first", sessionId: OWNER, everyMs: 100 },
			});
			await client.request({
				op: "schedule-set",
				spec: { name: "shared", message: "second", sessionId: SECOND_OWNER, everyMs: 100 },
			});
			await waitFor(() => firstFires.length > 0 && secondFires.length > 0, 5_000);
			expect(firstFires[0]?.schedule.message).toBe("first");
			expect(secondFires[0]?.schedule.message).toBe("second");

			const listed = await client.request({ op: "schedule-list" });
			if (listed.op !== "schedule-list") throw new Error("Unexpected schedule-list result");
			const shared = listed.schedules.filter(schedule => schedule.name === "shared");
			expect(shared).toHaveLength(2);
			expect(shared.find(schedule => schedule.sessionId === OWNER)?.message).toBe("first");
			expect(shared.find(schedule => schedule.sessionId === SECOND_OWNER)?.message).toBe("second");

			const cleared = await client.request({ op: "schedule-clear", name: "shared", sessionId: OWNER });
			if (cleared.op !== "schedule-clear") throw new Error("Unexpected schedule-clear result");
			expect(cleared.sessionId).toBe(OWNER);
			const afterClear = await client.request({ op: "schedule-list" });
			if (afterClear.op !== "schedule-list") throw new Error("Unexpected schedule-list result");
			const remaining = afterClear.schedules.filter(schedule => schedule.name === "shared");
			expect(remaining).toHaveLength(1);
			expect(remaining[0]?.sessionId).toBe(SECOND_OWNER);
		} finally {
			firstUnregister?.();
			secondUnregister?.();
			await shutdown(client);
		}
	}, 20_000);

	it("re-arms idle shutdown after a one-shot fire while preserving its replay", async () => {
		using tempDir = TempDir.createSync("@omp-schedule-idle-rearm-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
		const broker = startBroker(projectDir, runtimeDir, 1_000);
		await waitFor(async () => !(await brokerStopped(projectDir, runtimeDir)), 5_000);
		let replayBroker: Promise<void> | undefined;
		let replay: DaemonBrokerClient | undefined;
		let unregister: (() => void) | undefined;
		try {
			const set = await client.request({
				op: "schedule-set",
				spec: { name: "idle", message: "replay", sessionId: OWNER, at: Date.now() + 125 },
			});
			if (set.op !== "schedule-set") throw new Error("Unexpected schedule-set result");
			client.close();
			await waitFor(() => brokerStopped(projectDir, runtimeDir), 5_000);
			await broker;

			replayBroker = startBroker(projectDir, runtimeDir, 5_000);
			await waitFor(async () => !(await brokerStopped(projectDir, runtimeDir)), 5_000);
			replay = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const fires: ScheduleFireNotification[] = [];
			unregister = replay.onScheduleFire(OWNER, notification => {
				fires.push(notification);
			});
			await replay.request({ op: "ping" });
			await waitFor(() => fires.length === 1, 5_000);
			expect(fires[0]?.schedule.name).toBe("idle");
			expect(fires[0]?.schedule.message).toBe("replay");
		} finally {
			client.close();
			unregister?.();
			if (replay) await shutdown(replay);
			await broker;
			await replayBroker;
		}
	}, 20_000);

	it("rejects clearing an unknown schedule", async () => {
		using tempDir = TempDir.createSync("@omp-schedule-clear-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		try {
			await expect(client.request({ op: "schedule-clear", name: "ghost", sessionId: OWNER })).rejects.toThrow(
				/Unknown schedule ghost/,
			);
		} finally {
			await shutdown(client);
		}
	}, 20_000);
});

describe("hub schedule op validation", () => {
	it("requires exactly one of at or every for a set", () => {
		expect(() => buildScheduleSpec({ op: "schedule", name: "x", message: "m" }, OWNER)).toThrow(
			/exactly one of at or every/,
		);
		expect(() =>
			buildScheduleSpec({ op: "schedule", name: "x", message: "m", at: "2026-08-06T09:00:00", every: "20m" }, OWNER),
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
		expect(() => buildScheduleSpec({ op: "schedule", name: "x", message: "m", at: "not-a-date" }, OWNER)).toThrow(
			/ISO-8601 datetime/,
		);
		expect(() => buildScheduleSpec({ op: "schedule", name: "x", message: "m", every: "fortnight" }, OWNER)).toThrow(
			/duration like/,
		);
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

	it("rejects zero and negative repeat intervals at the broker wire and persistence boundaries", () => {
		for (const everyMs of [0, -1]) {
			const spec = { name: "x", message: "m", sessionId: OWNER, everyMs };
			expect(() =>
				parseDaemonWireRequest({
					id: `r-${everyMs}`,
					token: "t",
					operation: { op: "schedule-set", spec },
				}),
			).toThrow("schedule.everyMs must be a positive number");
			expect(() => parseScheduleSnapshot({ ...spec, nextDueAt: 1, firedCount: 0 })).toThrow(
				"schedule.everyMs must be a positive number",
			);
		}
	});

	it("accepts one-shot schedules without everyMs at the broker wire boundary", () => {
		const request = parseDaemonWireRequest({
			id: "r-once",
			token: "t",
			operation: {
				op: "schedule-set",
				spec: { name: "once", message: "m", sessionId: OWNER, at: 1 },
			},
		});
		expect(request.operation).toEqual({
			op: "schedule-set",
			spec: {
				name: "once",
				message: "m",
				sessionId: OWNER,
				at: 1,
				everyMs: undefined,
				whileDaemon: undefined,
			},
		});
	});
});
