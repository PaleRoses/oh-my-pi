import * as fs from "node:fs";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import chalk from "chalk";

const CONFIG_KEYS = {
	enabled: "omp.sourceUpdate",
	upstreamRemote: "omp.updateUpstreamRemote",
	upstreamBranch: "omp.updateUpstreamBranch",
	publishRemote: "omp.updatePublishRemote",
	publishBranch: "omp.updatePublishBranch",
} as const;

const FORK_VALIDATION_TESTS = [
	"test/modes/components/prompt-profile-selector.test.ts",
	"test/modes/controllers/selector-controller-prompt-profile.test.ts",
	"test/slash-commands/prompt.test.ts",
	"test/slash-commands/prompt-tui.test.ts",
	"test/system-prompt-profiles.test.ts",
	"test/system-prompt-profiles-sdk.test.ts",
	"test/system-prompt-model.test.ts",
	"test/agent-session-retry-fallback.test.ts",
	"test/cli/update-cli.test.ts",
	"test/source-checkout-update.test.ts",
];

const GENERATED_NATIVE_LOCKFILE = "MODULE.bazel.lock";

export interface SourceCheckoutUpdateOptions {
	readonly check: boolean;
	readonly checkout: string;
	readonly force: boolean;
}

export interface SourceCheckoutUpdateDependencies {
	readonly log?: (message: string) => void;
	readonly validate?: (checkout: string) => Promise<void>;
}

interface SourceUpdateConfig {
	readonly publishBranch: string;
	readonly publishRemote: string;
	readonly upstreamBranch: string;
	readonly upstreamRemote: string;
}

export type SourceCheckoutUpdateResult =
	| { readonly kind: "available"; readonly commits: number; readonly head: string; readonly upstream: string }
	| { readonly kind: "published"; readonly head: string; readonly previousPublishedHead: string }
	| { readonly kind: "updated"; readonly head: string; readonly previousHead: string; readonly upstream: string }
	| { readonly kind: "up-to-date"; readonly head: string }
	| { readonly kind: "verified"; readonly head: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function assertSafeRemoteName(value: string, key: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
		throw new Error(`Invalid source-update remote in ${key}: ${value}`);
	}
}

function assertSafeBranchName(value: string, key: string): void {
	const invalid =
		!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
		value.includes("..") ||
		value.includes("//") ||
		value.endsWith("/") ||
		value.endsWith(".") ||
		value.endsWith(".lock") ||
		value.includes("@{");
	if (invalid) throw new Error(`Invalid source-update branch in ${key}: ${value}`);
}

async function requireLocalConfig(checkout: string, key: string): Promise<string> {
	const value = await vcs.requireGit(checkout).configGet(key);
	if (!value) {
		throw new Error(
			`Source update is not configured: missing repository-local Git setting ${key}. ` +
				`Configure this checkout before running ${APP_NAME} update.`,
		);
	}
	return value;
}

async function loadConfig(checkout: string): Promise<SourceUpdateConfig> {
	const enabled = await vcs.requireGit(checkout).configGet(CONFIG_KEYS.enabled);
	if (enabled !== "true") {
		throw new Error(
			`This ${APP_NAME} runs from source checkout ${checkout}, but managed source updates are not enabled. ` +
				`Set repository-local ${CONFIG_KEYS.enabled}=true and the four source-update remote/branch settings; ` +
				"refusing to replace the source launcher with an official release.",
		);
	}
	const [upstreamRemote, upstreamBranch, publishRemote, publishBranch] = await Promise.all([
		requireLocalConfig(checkout, CONFIG_KEYS.upstreamRemote),
		requireLocalConfig(checkout, CONFIG_KEYS.upstreamBranch),
		requireLocalConfig(checkout, CONFIG_KEYS.publishRemote),
		requireLocalConfig(checkout, CONFIG_KEYS.publishBranch),
	]);
	assertSafeRemoteName(upstreamRemote, CONFIG_KEYS.upstreamRemote);
	assertSafeBranchName(upstreamBranch, CONFIG_KEYS.upstreamBranch);
	assertSafeRemoteName(publishRemote, CONFIG_KEYS.publishRemote);
	assertSafeBranchName(publishBranch, CONFIG_KEYS.publishBranch);
	return { upstreamRemote, upstreamBranch, publishRemote, publishBranch };
}

async function resolveCheckoutRoot(checkout: string): Promise<string> {
	let requestedRoot: string;
	try {
		requestedRoot = fs.realpathSync(path.resolve(checkout));
	} catch (error) {
		throw new Error(`Source checkout does not exist: ${checkout}`, { cause: error });
	}
	const discoveredRoot = vcs.git(requestedRoot)?.info().repoRoot ?? null;
	if (!discoveredRoot) throw new Error(`Source checkout is not a Git worktree: ${requestedRoot}`);
	const canonicalRoot = fs.realpathSync(discoveredRoot);
	if (canonicalRoot !== requestedRoot) {
		throw new Error(`Source checkout marker must name the worktree root: ${requestedRoot} (root: ${canonicalRoot})`);
	}
	return canonicalRoot;
}

async function fetchBranch(checkout: string, remote: string, branch: string): Promise<string> {
	const ref = `refs/remotes/${remote}/${branch}`;
	await vcs.requireGit(checkout).fetch(remote, `refs/heads/${branch}`, ref);
	const sha = await vcs.requireGit(checkout).resolveRef(ref);
	if (!sha) throw new Error(`Fetched ${remote}/${branch}, but ${ref} does not resolve to a commit`);
	return sha;
}

async function assertClean(checkout: string): Promise<void> {
	const state = await vcs.requireGit(checkout).statusPorcelain({ untracked: "all" });
	if (!state) return;
	const summary = state.split("\n").slice(0, 8).join("\n");
	throw new Error(`Source update requires a clean worktree. Commit or remove these changes first:\n${summary}`);
}

interface GitCommandResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

/** Updater-only porcelain edge for merge operations not exposed by upstream pi-vcs. */
async function runGit(checkout: string, args: readonly string[]): Promise<GitCommandResult> {
	let child: Subprocess<"ignore", "pipe", "pipe">;
	try {
		child = Bun.spawn(["git", ...args], {
			cwd: checkout,
			env: {
				...process.env,
				GIT_EDITOR: "true",
				GIT_MERGE_AUTOEDIT: "no",
				GIT_TERMINAL_PROMPT: "0",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		throw new Error(`Could not start git ${args[0] ?? "command"}`, { cause: error });
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
}

async function requireGit(checkout: string, args: readonly string[]): Promise<string> {
	const result = await runGit(checkout, args);
	if (result.exitCode === 0) return result.stdout;
	const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
	throw new Error(`git ${args[0] ?? "command"} failed: ${detail}`);
}

async function gitRevListCount(checkout: string, range: string): Promise<number> {
	const raw = await requireGit(checkout, ["rev-list", "--count", range]);
	if (!/^\d+$/.test(raw)) throw new Error(`git rev-list returned an invalid count: ${raw}`);
	return Number(raw);
}

async function runCommand(cwd: string, argv: readonly string[]): Promise<void> {
	let exitCode: number;
	try {
		const child = Bun.spawn([...argv], {
			cwd,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		exitCode = await child.exited;
	} catch (error) {
		throw new Error(`Could not run ${argv.join(" ")}: ${errorMessage(error)}`, { cause: error });
	}
	if (exitCode !== 0) throw new Error(`${argv.join(" ")} exited with code ${exitCode}`);
}

async function validateSourceCheckout(checkout: string): Promise<void> {
	const codingAgent = path.join(checkout, "packages", "coding-agent");
	await runCommand(checkout, ["bun", "install", "--frozen-lockfile"]);
	await runCommand(checkout, ["bun", "run", "build:native"]);
	await runCommand(codingAgent, ["bun", "run", "check"]);
	await runCommand(path.join(checkout, "packages", "natives"), ["bun", "test", "test/file-lock.test.ts"]);
	await runCommand(codingAgent, ["bun", "test", ...FORK_VALIDATION_TESTS]);
	await runCommand(codingAgent, ["bun", "run", "build"]);
}

async function stageGeneratedNativeLockfile(checkout: string): Promise<void> {
	const changed = await vcs.requireGit(checkout).changedFiles({ files: [GENERATED_NATIVE_LOCKFILE] });
	if (changed.includes(GENERATED_NATIVE_LOCKFILE)) {
		await vcs.requireGit(checkout).stageFiles([GENERATED_NATIVE_LOCKFILE]);
	}
}

async function assertValidationStable(checkout: string): Promise<void> {
	const summary = await vcs.requireGit(checkout).statusSummary();
	if (!summary) throw new Error("Could not inspect the source checkout after validation");
	if (summary.unstaged === 0 && summary.untracked === 0) return;
	throw new Error(
		`Validation changed the source checkout outside the merge index: ` +
			`${summary.unstaged} unstaged, ${summary.untracked} untracked.`,
	);
}

async function restoreFailedMerge(checkout: string, originalHead: string, failure: unknown): Promise<never> {
	let worktreeRestoreFailure: unknown;
	try {
		const summary = await vcs.requireGit(checkout).statusSummary();
		if (summary?.unstaged) await requireGit(checkout, ["checkout", "--", "."]);
	} catch (error) {
		worktreeRestoreFailure = error;
	}
	let abortFailure: unknown;
	try {
		await requireGit(checkout, ["merge", "--abort"]);
	} catch (error) {
		abortFailure = error;
	}
	const [restoredHead, state] = await Promise.all([
		vcs.requireGit(checkout).headSha(),
		vcs.requireGit(checkout).statusPorcelain({ untracked: "all" }),
	]);
	if (restoredHead !== originalHead || state) {
		const rollbackDetail = [
			worktreeRestoreFailure ? `Worktree restore failed: ${errorMessage(worktreeRestoreFailure)}.` : "",
			abortFailure ? `Merge abort failed: ${errorMessage(abortFailure)}.` : "",
		]
			.filter(Boolean)
			.join(" ");
		throw new Error(
			`Source update failed and the checkout could not be restored automatically. ${rollbackDetail} ` +
				`Original HEAD: ${originalHead}; current HEAD: ${restoredHead ?? "missing"}; status: ${state || "clean"}.`,
			{ cause: failure },
		);
	}
	throw new Error(`Source update failed; checkout restored to ${originalHead}: ${errorMessage(failure)}`, {
		cause: failure,
	});
}

function logSource(log: (message: string) => void, checkout: string, config: SourceUpdateConfig): void {
	log(chalk.dim(`Source checkout: ${checkout}`));
	log(chalk.dim(`Upstream: ${config.upstreamRemote}/${config.upstreamBranch}`));
	log(chalk.dim(`Publish: ${config.publishRemote}/${config.publishBranch}`));
}

export async function runSourceCheckoutUpdate(
	options: SourceCheckoutUpdateOptions,
	dependencies: SourceCheckoutUpdateDependencies = {},
): Promise<SourceCheckoutUpdateResult> {
	const log = dependencies.log ?? console.log;
	const validate = dependencies.validate ?? validateSourceCheckout;
	const checkout = await resolveCheckoutRoot(options.checkout);
	const config = await loadConfig(checkout);
	const originalHead = await vcs.requireGit(checkout).headSha();
	if (!originalHead) throw new Error(`Source checkout has no HEAD commit: ${checkout}`);
	logSource(log, checkout, config);

	const publishedHead = await fetchBranch(checkout, config.publishRemote, config.publishBranch);
	if ((await vcs.requireGit(checkout).mergeBase(publishedHead, originalHead)) !== publishedHead) {
		throw new Error(
			`${config.publishRemote}/${config.publishBranch} contains commits absent from local HEAD. ` +
				"Refusing a non-fast-forward publication; integrate that branch first.",
		);
	}
	const upstreamHead = await fetchBranch(checkout, config.upstreamRemote, config.upstreamBranch);
	const upstreamContained = (await vcs.requireGit(checkout).mergeBase(upstreamHead, originalHead)) === upstreamHead;
	const unpublished = publishedHead !== originalHead;

	if (options.check) {
		if (upstreamContained) {
			log(chalk.green("Source checkout is up to date"));
		} else {
			const commits = await gitRevListCount(checkout, `${originalHead}..${upstreamHead}`);
			log(chalk.cyan(`${commits} upstream commit${commits === 1 ? "" : "s"} available`));
			return { kind: "available", commits, head: originalHead, upstream: upstreamHead };
		}
		if (unpublished) {
			const commits = await gitRevListCount(checkout, `${publishedHead}..${originalHead}`);
			log(chalk.yellow(`${commits} local commit${commits === 1 ? "" : "s"} not yet published`));
		}
		return { kind: "up-to-date", head: originalHead };
	}

	await assertClean(checkout);
	if (upstreamContained) {
		if (options.force || unpublished) {
			log(chalk.dim("Validating source checkout..."));
			await validate(checkout);
			await assertValidationStable(checkout);
		}
		if (unpublished) {
			await vcs.requireGit(checkout).push({
				remote: config.publishRemote,
				refspec: `HEAD:refs/heads/${config.publishBranch}`,
			});
			log(chalk.green(`Published ${config.publishRemote}/${config.publishBranch}`));
			return { kind: "published", head: originalHead, previousPublishedHead: publishedHead };
		}
		if (options.force) {
			log(chalk.green("Source checkout verified"));
			return { kind: "verified", head: originalHead };
		}
		log(chalk.green("Source checkout is already up to date"));
		return { kind: "up-to-date", head: originalHead };
	}

	const commits = await gitRevListCount(checkout, `${originalHead}..${upstreamHead}`);
	log(chalk.cyan(`Merging ${commits} upstream commit${commits === 1 ? "" : "s"}...`));
	try {
		await requireGit(checkout, ["merge", "--no-commit", "--no-ff", "--", upstreamHead]);
		await validate(checkout);
		await stageGeneratedNativeLockfile(checkout);
		await assertValidationStable(checkout);
		await requireGit(checkout, [
			"commit",
			"-m",
			`Merge ${config.upstreamRemote}/${config.upstreamBranch} into ${config.publishBranch}`,
		]);
	} catch (error) {
		return await restoreFailedMerge(checkout, originalHead, error);
	}
	const updatedHead = await vcs.requireGit(checkout).headSha();
	if (!updatedHead || updatedHead === originalHead) {
		throw new Error(`Source update did not create a merge commit from ${originalHead}`);
	}
	try {
		await vcs.requireGit(checkout).push({
			remote: config.publishRemote,
			refspec: `HEAD:refs/heads/${config.publishBranch}`,
		});
	} catch (error) {
		throw new Error(
			`Source update committed ${updatedHead}, but publication failed. Retry: git push ${config.publishRemote} ` +
				`HEAD:refs/heads/${config.publishBranch}. ${errorMessage(error)}`,
			{ cause: error },
		);
	}
	log(chalk.green(`Updated and published ${updatedHead.slice(0, 10)}`));
	log(chalk.dim(`Restart ${APP_NAME} to load the updated source`));
	return { kind: "updated", head: updatedHead, previousHead: originalHead, upstream: upstreamHead };
}
