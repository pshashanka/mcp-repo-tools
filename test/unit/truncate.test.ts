import { describe, expect, it } from "vitest";
import { keepHead, keepTail } from "../../src/lib/truncate.js";

describe("keepHead", () => {
  it("returns short text unchanged", () => {
    expect(keepHead("hello", 5)).toEqual({ text: "hello", truncated: false });
  });

  it("keeps the first maxBytes bytes", () => {
    expect(keepHead("hello world", 5)).toEqual({ text: "hello", truncated: true });
  });

  it("never splits a multi-byte character", () => {
    // "é" is 2 bytes, so a 2-byte limit lands inside the second character.
    expect(keepHead("aé", 2)).toEqual({ text: "a", truncated: true });
    expect(keepHead("😀😀", 5)).toEqual({ text: "😀", truncated: true });
  });
});

describe("keepTail", () => {
  it("returns short text unchanged", () => {
    expect(keepTail("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  it("keeps the last maxBytes bytes", () => {
    expect(keepTail("hello world", 5)).toEqual({ text: "world", truncated: true });
  });

  it("never splits a multi-byte character", () => {
    expect(keepTail("éa", 2)).toEqual({ text: "a", truncated: true });
    expect(keepTail("😀😀", 5)).toEqual({ text: "😀", truncated: true });
  });
});
