import { describe, it, expect, vi } from "vitest";
import { fetchWithAuthRetry } from "./with-auth-retry";

function res(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

describe("fetchWithAuthRetry (EA-H6: token expiry → refresh → retry)", () => {
  it("returns the response directly when it succeeds first try", async () => {
    const doFetch = vi.fn(async () => res(200));
    const refresh = vi.fn(async () => "new");
    const out = await fetchWithAuthRetry({
      getToken: () => "tok",
      refresh,
      doFetch,
    });
    expect(out.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(doFetch).toHaveBeenCalledWith("tok");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("on 401, refreshes once and retries with the new token", async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(200));
    const refresh = vi.fn(async () => "fresh-token");
    const out = await fetchWithAuthRetry({ getToken: () => "stale", refresh, doFetch });
    expect(out.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(doFetch).toHaveBeenNthCalledWith(1, "stale");
    expect(doFetch).toHaveBeenNthCalledWith(2, "fresh-token");
  });

  it("when refresh fails after a 401, returns the 401 and signals auth-expired", async () => {
    const doFetch = vi.fn(async () => res(401));
    const refresh = vi.fn(async () => null);
    const onAuthExpired = vi.fn();
    const out = await fetchWithAuthRetry({
      getToken: () => "stale",
      refresh,
      doFetch,
      onAuthExpired,
    });
    expect(out.status).toBe(401);
    expect(doFetch).toHaveBeenCalledTimes(1); // no retry without a fresh token
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
  });

  it("with no cached token, refreshes before the first request", async () => {
    const doFetch = vi.fn(async () => res(200));
    const refresh = vi.fn(async () => "minted");
    const out = await fetchWithAuthRetry({ getToken: () => null, refresh, doFetch });
    expect(out.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(doFetch).toHaveBeenCalledWith("minted");
  });

  it("with no token and refresh failing, throws and signals auth-expired", async () => {
    const doFetch = vi.fn(async () => res(200));
    const refresh = vi.fn(async () => null);
    const onAuthExpired = vi.fn();
    await expect(
      fetchWithAuthRetry({ getToken: () => null, refresh, doFetch, onAuthExpired })
    ).rejects.toThrow("Not logged in");
    expect(doFetch).not.toHaveBeenCalled();
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
  });

  it("does not retry on non-401 errors (e.g. 500)", async () => {
    const doFetch = vi.fn(async () => res(500));
    const refresh = vi.fn(async () => "new");
    const out = await fetchWithAuthRetry({ getToken: () => "tok", refresh, doFetch });
    expect(out.status).toBe(500);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
