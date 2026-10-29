import { describe, expect, it } from "vitest";
import { describeListingProgress, describePage } from "../src/cli/ui.js";

describe("listing progress text", () => {
  it("shows the page in flight and the running clone count", () => {
    expect(describeListingProgress({ phase: "fetching", page: 3, totalClones: 61, totalCancelled: 4000 })).toBe(
      "Reading page 3… 61 clone(s) retrieved so far, 4000 cancelled ignored"
    );
    expect(describeListingProgress({ phase: "done", page: 3, totalClones: 63 })).toBe("page 3 done, 63 clone(s) retrieved so far");
    expect(describeListingProgress({ phase: "fetching", page: 2, totalPages: 12, totalClones: 5 })).toBe("Reading chunk 2/12… 5 clone(s) retrieved so far");
    expect(describeListingProgress({ phase: "fetching", page: 0, totalClones: 0 })).toContain("Querying calendar");
  });

  it("describes a completed page including what was ignored", () => {
    expect(describePage({ page: 1, itemsOnPage: 1562, clonesOnPage: 61, ignoredOnPage: 1501, cancelledOnPage: 1500, totalClones: 61 })).toBe(
      "Page 1: 1562 events read, 61 clone(s) found, ignored 1500 cancelled (already deleted) + 1 not a clone (total clones 61)"
    );
    expect(describePage({ page: 2, totalPages: 3, itemsOnPage: 100, clonesOnPage: 100, ignoredOnPage: 0, totalClones: 200 })).toBe(
      "Chunk 2/3: 100 events read, 100 clone(s) found (total clones 200)"
    );
  });
});
