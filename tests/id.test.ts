import { describe, expect, it } from "vitest";
import { encodeId, parseId } from "../src/types.js";

describe("cell ids", () => {
  it("roundtrips a1/b12/c1", () => {
    for (const [letter, index] of [
      ["a", 0],
      ["b", 11],
      ["c", 0],
      ["z", 47],
    ] as const) {
      const id = encodeId(letter, index);
      expect(id).toBe(`${letter}${index + 1}`);
      expect(parseId(id)).toEqual({ roundLetter: letter, index });
    }
  });

  it("rejects malformed ids", () => {
    for (const bad of ["", "a0", "a", "1a", "aa1", "a-1", "a1b", "A1", "a 1"]) {
      expect(parseId(bad), `should reject ${bad}`).toBeNull();
    }
  });
});
