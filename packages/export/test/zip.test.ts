import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { zip } from "../src/zip.ts";

const tz = process.env.TZ;
afterEach(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

/** The DOS date and time of every local header and central directory entry. */
function stamps(archive: Uint8Array): string[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const out: string[] = [];
  for (let p = 0; p + 4 <= archive.length; p++) {
    const sig = view.getUint32(p, true);
    const at = sig === 0x04034b50 ? p + 10 : sig === 0x02014b50 ? p + 12 : -1;
    if (at < 0) continue;
    const [time, day] = [view.getUint16(at, true), view.getUint16(at + 2, true)];
    out.push(`${1980 + (day >> 9)}-${(day >> 5) & 15}-${day & 31} ${time >> 11}:${(time >> 5) & 63}:${(time & 31) * 2}`);
  }
  return out;
}

describe("zip", () => {
  const entries = [
    { path: "mimetype", data: "application/epub+zip", store: true },
    { path: "OEBPS/a.xhtml", data: "<p>Hello</p>".repeat(50) },
  ];
  const date = new Date("2026-10-09T23:30:10Z");

  it("dates every file in UTC, so any machine's clock zone makes the same bytes", () => {
    process.env.TZ = "America/New_York";
    const east = zip(entries, date);
    process.env.TZ = "Asia/Tokyo";
    const tokyo = zip(entries, date);
    process.env.TZ = "UTC";
    const utc = zip(entries, date);
    expect(Buffer.from(east).equals(Buffer.from(utc))).toBe(true);
    expect(Buffer.from(tokyo).equals(Buffer.from(utc))).toBe(true);
    expect(stamps(utc)).toEqual(Array(4).fill("2026-10-9 23:30:10"));
    expect(Object.keys(unzipSync(utc))).toEqual(["mimetype", "OEBPS/a.xhtml"]);
  });

  it("dates before 1980, which zip can't hold, as its first day", () => {
    expect(stamps(zip(entries, new Date(0)))).toEqual(Array(4).fill("1980-1-1 0:0:0"));
  });
});
