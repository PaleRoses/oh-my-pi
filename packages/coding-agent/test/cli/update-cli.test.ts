import { afterEach, describe, expect, it, vi } from "bun:test";
import * as sourceCheckoutUpdate from "../../src/cli/source-checkout-update";
import { runUpdateCommand } from "../../src/cli/update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ version: "999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

describe("runUpdateCommand source checkout dispatch", () => {
	const originalSourceCheckout = Bun.env.OMP_SOURCE_CHECKOUT;

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalSourceCheckout === undefined) {
			delete Bun.env.OMP_SOURCE_CHECKOUT;
		} else {
			Bun.env.OMP_SOURCE_CHECKOUT = originalSourceCheckout;
		}
	});

	it("routes source launchers before official release discovery", async () => {
		Bun.env.OMP_SOURCE_CHECKOUT = "/tmp/omp-source-checkout";
		const sourceUpdate = vi
			.spyOn(sourceCheckoutUpdate, "runSourceCheckoutUpdate")
			.mockResolvedValue({ kind: "up-to-date", head: "source-head" });
		const releaseFetch = vi.spyOn(globalThis, "fetch");

		await runUpdateCommand({ force: true, check: false });

		expect(sourceUpdate).toHaveBeenCalledWith({
			check: false,
			checkout: "/tmp/omp-source-checkout",
			force: true,
		});
		expect(releaseFetch).not.toHaveBeenCalled();
	});
});
