import { describe, it, expect } from "vitest";
import { formatPosition, parsePosition } from "../src/position.js";

describe("parsePosition", () => {
  it("parses Tone.js bars:beats:sixteenths strings", () => {
    expect(parsePosition("0:0:0")).toBe(0);
    expect(parsePosition("1:0:0")).toBe(4);
    expect(parsePosition("1:2:3")).toBe(4 + 2 + 3 / 4);
    expect(parsePosition("2:3:1")).toBe(8 + 3 + 1 / 4);
  });

  it("tolerates whitespace", () => {
    expect(parsePosition(" 1:2:3 ")).toBe(4 + 2 + 3 / 4);
  });

  it("accepts plain (fractional) beat counts", () => {
    expect(parsePosition(7.25)).toBe(7.25);
    expect(parsePosition(-1)).toBe(0); // clamped to zero
  });

  it("returns undefined for junk (=> caller resumes instead)", () => {
    expect(parsePosition("")).toBeUndefined();
    expect(parsePosition("not:a:position")).toBeUndefined();
    expect(parsePosition(undefined)).toBeUndefined();
    expect(parsePosition(null)).toBeUndefined();
    expect(parsePosition(NaN)).toBeUndefined();
  });
});

describe("formatPosition", () => {
  it("formats beats into bars:beats:sixteenths", () => {
    expect(formatPosition(0)).toBe("0:0:0");
    expect(formatPosition(4)).toBe("1:0:0");
    expect(formatPosition(4 + 2 + 3 / 4)).toBe("1:2:3");
  });

  it("snaps to the nearest sixteenth", () => {
    expect(formatPosition(4.03)).toBe("1:0:0");
    expect(formatPosition(3.97)).toBe("1:0:0");
  });

  it("defends against negative/NaN beats", () => {
    expect(formatPosition(-5)).toBe("0:0:0");
    expect(formatPosition(NaN)).toBe("0:0:0");
  });
});
