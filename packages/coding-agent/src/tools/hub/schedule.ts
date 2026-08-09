/**
 * Hub schedule half — broker-owned schedules/heartbeats. The hub `schedule`
 * op upserts one schedule by name (one-shot `at` or repeating `every`),
 * lists, or clears it. Fires are pushed to the socket subscribed for the
 * schedule's session and delivered through the session's IRC path with a
 * synthetic `schedule:<name>` sender; with no live subscriber the broker
 * retains only the latest undelivered fire per name for replay on reconnect.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerClient, daemonClientForProject } from "../../launch/client";
import type { DaemonOperation, ScheduleSnapshot, ScheduleSpec } from "../../launch/protocol";
import { parseDurationMs } from "../../modes/loop-limit";
import type { ToolSession } from "..";
import { ToolError } from "../tool-errors";

/** Hub-facing schedule parameters; the broker operation is derived from these flags. */
export interface ScheduleParams {
	op: "schedule";
	/** Schedule name: the upsert/clear key. */
	name?: string;
	/** Message delivered to the session when the schedule fires. */
	message?: string;
	/** ISO-8601 datetime for a one-shot fire; exactly one of `at`/`every` required for set. */
	at?: string;
	/** Repeat interval duration string ("20m", "2h", "1h30m"); exactly one of `at`/`every` required for set. */
	every?: string;
	/** Broker daemon name guarding fires: the schedule cancels instead of firing while it is not live. */
	while?: string;
	/** List schedules instead of setting/clearing. */
	list?: boolean;
	/** Clear the schedule named by `name`. */
	clear?: boolean;
}

/** Details surfaced by the hub schedule op. */
export interface ScheduleDetails {
	op: "schedule";
	name?: string;
	schedules?: ScheduleSnapshot[];
}

const scheduleFireRegistrations = new WeakMap<ToolSession, Map<DaemonBrokerClient, { cleanup: () => void }>>();

/** Register the schedule-fire sink for the calling session once per broker client. */
function registerScheduleFireSink(session: ToolSession, client: DaemonBrokerClient): void {
	if (!session.queueScheduleFire) return;
	let clients = scheduleFireRegistrations.get(session);
	if (!clients) {
		clients = new Map();
		scheduleFireRegistrations.set(session, clients);
	}
	if (clients.has(client)) return;
	const sessionId = session.getSessionId?.() ?? null;
	if (!sessionId) return;
	const unregister = client.onScheduleFire(sessionId, notification => {
		if (session.isDisposed?.()) throw new Error("Session disposed before schedule fire delivery");
		const delivery = session.queueScheduleFire?.(notification);
		if (!delivery) throw new Error("Session cannot accept schedule fire delivery");
		return delivery.then(() => undefined);
	});
	let unregisterDispose: (() => void) | void;
	let unregisterSessionChange: (() => void) | void;
	const cleanup = (): void => {
		const registered = clients.get(client);
		if (!registered) return;
		unregister();
		unregisterDispose?.();
		unregisterSessionChange?.();
		clients.delete(client);
		if (clients.size === 0) scheduleFireRegistrations.delete(session);
	};
	unregisterDispose = session.registerDisposeCallback?.(() => cleanup());
	unregisterSessionChange = session.registerSessionChangeCallback?.(() => cleanup());
	clients.set(client, { cleanup });
}

/**
 * Validate hub schedule params into a broker `ScheduleSpec`. Returns
 * `undefined` for the list/clear forms (they need no spec); throws `ToolError`
 * for invalid set forms (missing name/message, invalid datetime/duration, or
 * not exactly one of `at`/`every`).
 */
export function buildScheduleSpec(params: ScheduleParams, sessionId: string): ScheduleSpec | undefined {
	if (params.list || params.clear) return undefined;
	const name = params.name?.trim();
	if (!name) throw new ToolError("schedule requires name");
	const message = params.message?.trim();
	if (!message) throw new ToolError("schedule set requires message");
	const atMs = params.at === undefined ? undefined : Date.parse(params.at);
	if (params.at !== undefined && !Number.isFinite(atMs)) {
		throw new ToolError(`schedule at must be an ISO-8601 datetime: ${params.at}`);
	}
	const everyMs = params.every === undefined ? undefined : parseDurationMs(params.every);
	if (params.every !== undefined && everyMs === undefined) {
		throw new ToolError(`schedule every must be a duration like "20m" or "2h": ${params.every}`);
	}
	if ((atMs === undefined) === (everyMs === undefined)) {
		throw new ToolError("schedule set requires exactly one of at or every");
	}
	return {
		name,
		message,
		sessionId,
		at: atMs,
		everyMs,
		whileDaemon: params.while?.trim() || undefined,
	};
}

function scheduleLabel(schedule: ScheduleSnapshot): string {
	const kind =
		schedule.everyMs !== undefined
			? `every ${formatDuration(schedule.everyMs)}`
			: `at ${new Date(schedule.at ?? schedule.nextDueAt).toISOString()}`;
	const guard = schedule.whileDaemon !== undefined ? ` while=${schedule.whileDaemon}` : "";
	return `${schedule.name}: ${kind}${guard} (fired ${schedule.firedCount}; next ${new Date(schedule.nextDueAt).toISOString()})`;
}

/** Run one schedule operation for the calling session's project. */
export async function executeSchedule(
	session: ToolSession,
	params: ScheduleParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<ScheduleDetails>> {
	const client = await daemonClientForProject(session.cwd);
	const sessionId = session.getSessionId?.() ?? null;
	if (!sessionId) throw new ToolError("schedule requires a session id");
	registerScheduleFireSink(session, client);
	let operation: DaemonOperation;
	if (params.list) {
		operation = { op: "schedule-list" };
	} else if (params.clear) {
		const name = params.name?.trim();
		if (!name) throw new ToolError("schedule clear requires name");
		operation = { op: "schedule-clear", name };
	} else {
		const spec = buildScheduleSpec(params, sessionId);
		if (!spec) throw new ToolError("schedule requires at or every");
		operation = { op: "schedule-set", spec };
	}
	const result = await client.request(operation, signal);
	switch (result.op) {
		case "schedule-set":
			return {
				content: [
					{
						type: "text",
						text: `Schedule ${result.schedule.name} set — next fire ${new Date(result.schedule.nextDueAt).toISOString()}`,
					},
				],
				details: { op: "schedule", name: result.schedule.name },
			};
		case "schedule-list":
			return {
				content: [
					{
						type: "text",
						text: result.schedules.length ? result.schedules.map(scheduleLabel).join("\n") : "No schedules.",
					},
				],
				details: { op: "schedule", schedules: result.schedules },
			};
		case "schedule-clear":
			return {
				content: [{ type: "text", text: `Cleared schedule ${result.name}` }],
				details: { op: "schedule", name: result.name },
			};
		default:
			throw new ToolError(`Internal daemon result ${result.op} is not schedule-visible`);
	}
}
