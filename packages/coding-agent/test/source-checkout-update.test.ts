import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	runSourceCheckoutUpdate,
	type SourceCheckoutUpdateResult,
} from "@oh-my-pi/pi-coding-agent/cli/source-checkout-update";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Fixture {
	readonly checkout: string;
	readonly origin: string;
	readonly originalHead: string;
	readonly root: TempDir;
	readonly seed: string;
	readonly upstream: string;
}

const tempDirs: TempDir[] = [];

function runGit(cwd: string, args: readonly string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString().trim();
	const stderr = result.stderr.toString().trim();
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${stderr || stdout}`);
	}
	return stdout;
}

function configureIdentity(cwd: string): void {
	runGit(cwd, ["config", "user.name", "Source Update Test"]);
	runGit(cwd, ["config", "user.email", "source-update@example.invalid"]);
}

function configureSourceUpdate(cwd: string): void {
	const entries = [
		["omp.sourceUpdate", "true"],
		["omp.updateUpstreamRemote", "upstream"],
		["omp.updateUpstreamBranch", "main"],
		["omp.updatePublishRemote", "origin"],
		["omp.updatePublishBranch", "agent-profiles"],
	] as const;
	entries.forEach(([key, value]) => {
		runGit(cwd, ["config", "--local", key, value]);
	});
}

function createFixture(): Fixture {
	const root = TempDir.createSync("@omp-source-update-");
	tempDirs.push(root);
	const origin = path.join(root.path(), "origin.git");
	const upstream = path.join(root.path(), "upstream.git");
	const seed = path.join(root.path(), "seed");
	const checkout = path.join(root.path(), "checkout");
	fs.mkdirSync(seed);
	runGit(root.path(), ["init", "--bare", origin]);
	runGit(root.path(), ["init", "--bare", upstream]);
	runGit(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	runGit(upstream, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	runGit(seed, ["init", "-b", "main"]);
	configureIdentity(seed);
	fs.writeFileSync(path.join(seed, "state.txt"), "base\n");
	fs.writeFileSync(path.join(seed, "MODULE.bazel.lock"), "base lock\n");
	runGit(seed, ["add", "state.txt", "MODULE.bazel.lock"]);
	runGit(seed, ["commit", "-m", "base"]);
	runGit(seed, ["remote", "add", "origin", origin]);
	runGit(seed, ["remote", "add", "upstream", upstream]);
	runGit(seed, ["push", "origin", "main"]);
	runGit(seed, ["push", "upstream", "main"]);
	runGit(root.path(), ["clone", origin, checkout]);
	configureIdentity(checkout);
	runGit(checkout, ["remote", "add", "upstream", upstream]);
	runGit(checkout, ["checkout", "--detach"]);
	fs.writeFileSync(path.join(checkout, "state.txt"), "custom\n");
	runGit(checkout, ["add", "state.txt"]);
	runGit(checkout, ["commit", "-m", "custom"]);
	runGit(checkout, ["push", "origin", "HEAD:refs/heads/agent-profiles"]);
	configureSourceUpdate(checkout);
	return {
		checkout,
		origin,
		originalHead: runGit(checkout, ["rev-parse", "HEAD"]),
		root,
		seed,
		upstream,
	};
}

function advanceUpstream(fixture: Fixture, conflict = false): string {
	const file = conflict ? "state.txt" : "upstream.txt";
	fs.writeFileSync(path.join(fixture.seed, file), conflict ? "upstream\n" : "upstream addition\n");
	runGit(fixture.seed, ["add", file]);
	runGit(fixture.seed, ["commit", "-m", conflict ? "conflicting upstream" : "upstream addition"]);
	runGit(fixture.seed, ["push", "upstream", "main"]);
	return runGit(fixture.seed, ["rev-parse", "HEAD"]);
}

function publishedHead(fixture: Fixture): string {
	return runGit(fixture.origin, ["rev-parse", "refs/heads/agent-profiles"]);
}

async function update(
	fixture: Fixture,
	options: { check?: boolean; force?: boolean; validate?: (checkout: string) => Promise<void> } = {},
): Promise<SourceCheckoutUpdateResult> {
	return runSourceCheckoutUpdate(
		{
			checkout: fixture.checkout,
			check: options.check ?? false,
			force: options.force ?? false,
		},
		{ log: () => {}, validate: options.validate ?? (async () => {}) },
	);
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("source checkout update", () => {
	it("reports upstream commits without changing the checkout", async () => {
		const fixture = createFixture();
		const upstreamHead = advanceUpstream(fixture);

		const result = await update(fixture, {
			check: true,
			validate: async () => {
				throw new Error("check-only mode must not validate");
			},
		});

		expect(result).toEqual({ kind: "available", commits: 1, head: fixture.originalHead, upstream: upstreamHead });
		expect(runGit(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.originalHead);
		expect(runGit(fixture.checkout, ["status", "--porcelain"])).toBe("");
		expect(publishedHead(fixture)).toBe(fixture.originalHead);
	});

	it("leaves an up-to-date checkout untouched", async () => {
		const fixture = createFixture();
		let validations = 0;

		const result = await update(fixture, {
			validate: async () => {
				validations++;
			},
		});

		expect(result).toEqual({ kind: "up-to-date", head: fixture.originalHead });
		expect(validations).toBe(0);
		expect(runGit(fixture.checkout, ["status", "--porcelain"])).toBe("");
	});

	it("merges, validates, commits, and publishes without attaching HEAD", async () => {
		const fixture = createFixture();
		const upstreamHead = advanceUpstream(fixture);
		let validations = 0;

		const result = await update(fixture, {
			validate: async checkout => {
				validations++;
				expect(runGit(checkout, ["status", "--porcelain"])).toContain("upstream.txt");
			},
		});

		expect(result.kind).toBe("updated");
		expect(validations).toBe(1);
		const mergedHead = runGit(fixture.checkout, ["rev-parse", "HEAD"]);
		expect(runGit(fixture.checkout, ["show", "-s", "--format=%P", "HEAD"]).split(" ")).toEqual([
			fixture.originalHead,
			upstreamHead,
		]);
		expect(runGit(fixture.checkout, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
		expect(publishedHead(fixture)).toBe(mergedHead);
		expect(runGit(fixture.checkout, ["status", "--porcelain"])).toBe("");
	});

	it("commits a native lockfile regenerated during merge validation", async () => {
		const fixture = createFixture();
		advanceUpstream(fixture);

		const result = await update(fixture, {
			validate: async checkout => {
				fs.writeFileSync(path.join(checkout, "MODULE.bazel.lock"), "regenerated lock\n");
			},
		});

		expect(result.kind).toBe("updated");
		expect(runGit(fixture.checkout, ["show", "HEAD:MODULE.bazel.lock"])).toBe("regenerated lock");
		expect(runGit(fixture.checkout, ["status", "--porcelain"])).toBe("");
	});

	it("aborts a conflicting merge and restores the original checkout", async () => {
		const fixture = createFixture();
		advanceUpstream(fixture, true);

		await expect(update(fixture)).rejects.toThrow(/checkout restored/);

		expect(runGit(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.originalHead);
		expect(runGit(fixture.checkout, ["status", "--porcelain"])).toBe("");
		expect(fs.readFileSync(path.join(fixture.checkout, "state.txt"), "utf8")).toBe("custom\n");
		expect(publishedHead(fixture)).toBe(fixture.originalHead);
	});

	it("aborts a merge whose validation fails", async () => {
		const fixture = createFixture();
		advanceUpstream(fixture);

		await expect(
			update(fixture, {
				validate: async () => {
					throw new Error("validation refused the merge");
				},
			}),
		).rejects.toThrow(/checkout restored.*validation refused the merge/);

		expect(runGit(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.originalHead);
		expect(runGit(fixture.checkout, ["status", "--porcelain"])).toBe("");
		expect(publishedHead(fixture)).toBe(fixture.originalHead);
	});

	it("aborts a merge when validation changes a staged merge file", async () => {
		const fixture = createFixture();
		advanceUpstream(fixture);

		await expect(
			update(fixture, {
				validate: async checkout => {
					fs.writeFileSync(path.join(checkout, "upstream.txt"), "validation drift\n");
				},
			}),
		).rejects.toThrow(/checkout restored.*Validation changed the source checkout/);

		expect(runGit(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.originalHead);
		expect(runGit(fixture.checkout, ["status", "--porcelain"])).toBe("");
		expect(fs.existsSync(path.join(fixture.checkout, "upstream.txt"))).toBe(false);
		expect(publishedHead(fixture)).toBe(fixture.originalHead);
	});

	it("refuses publication history that is absent from local HEAD", async () => {
		const fixture = createFixture();
		const writer = path.join(fixture.root.path(), "writer");
		runGit(fixture.root.path(), ["clone", "--branch", "agent-profiles", fixture.origin, writer]);
		configureIdentity(writer);
		fs.writeFileSync(path.join(writer, "remote.txt"), "remote-only\n");
		runGit(writer, ["add", "remote.txt"]);
		runGit(writer, ["commit", "-m", "remote-only"]);
		runGit(writer, ["push", "origin", "agent-profiles"]);

		await expect(update(fixture, { check: true })).rejects.toThrow(/contains commits absent from local HEAD/);
		expect(runGit(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.originalHead);
		expect(runGit(fixture.checkout, ["status", "--porcelain"])).toBe("");
	});
});
