import { describe, expect, it } from "vitest";
import { HostBuffer, NO_OWNER } from "ukibori-renderer";
import { compositeSurfaceImage, DEFAULT_SHADOW_ALPHA } from "./compositor";

function colorBuffer(width: number, height: number): HostBuffer {
  return new HostBuffer({ width, height, channels: 4, format: "u8" });
}

function ownerBuffer(width: number, height: number, fill: number): HostBuffer {
  const buf = new HostBuffer({ width, height, channels: 1, format: "u32" });
  buf.fill(fill);
  return buf;
}

function visibilityBuffer(width: number, height: number, fill: number): HostBuffer {
  const buf = new HostBuffer({ width, height, channels: 1, format: "f32" });
  buf.fill(fill);
  return buf;
}

describe("compositeSurfaceImage", () => {
  it("keeps surface pixels opaque with the renderer color", () => {
    const color = colorBuffer(2, 1);
    color.set(0, 0, 0, 200);
    color.set(0, 0, 1, 100);
    color.set(0, 0, 2, 50);
    color.set(0, 0, 3, 255);
    const objectId = ownerBuffer(2, 1, 0); // surface index 0 owns every pixel
    const image = compositeSurfaceImage({
      color,
      objectId,
      visibility: visibilityBuffer(2, 1, 1),
    });
    expect(image.width).toBe(2);
    expect(image.data[0]).toBe(200);
    expect(image.data[1]).toBe(100);
    expect(image.data[2]).toBe(50);
    expect(image.data[3]).toBe(255);
  });

  it("makes lit base-plane pixels fully transparent", () => {
    const color = colorBuffer(1, 1);
    color.set(0, 0, 0, 120);
    color.set(0, 0, 1, 120);
    color.set(0, 0, 2, 120);
    color.set(0, 0, 3, 255);
    const image = compositeSurfaceImage({
      color,
      objectId: ownerBuffer(1, 1, NO_OWNER),
      visibility: visibilityBuffer(1, 1, 1),
    });
    expect(image.data[0]).toBe(0);
    expect(image.data[1]).toBe(0);
    expect(image.data[2]).toBe(0);
    expect(image.data[3]).toBe(0);
  });

  it("paints shadowed base-plane pixels as translucent shadow color", () => {
    const image = compositeSurfaceImage({
      color: colorBuffer(1, 1),
      objectId: ownerBuffer(1, 1, NO_OWNER),
      visibility: visibilityBuffer(1, 1, 0),
    });
    expect(image.data[0]).toBe(12);
    expect(image.data[1]).toBe(16);
    expect(image.data[2]).toBe(28);
    expect(image.data[3]).toBe(Math.round(DEFAULT_SHADOW_ALPHA * 255));
  });

  it("honors custom shadow color and alpha", () => {
    const image = compositeSurfaceImage(
      {
        color: colorBuffer(1, 1),
        objectId: ownerBuffer(1, 1, NO_OWNER),
        visibility: visibilityBuffer(1, 1, 0),
      },
      { shadowColor: [255, 0, 0], shadowAlpha: 0.5 },
    );
    expect(image.data[0]).toBe(255);
    expect(image.data[1]).toBe(0);
    expect(image.data[2]).toBe(0);
    expect(image.data[3]).toBe(128);
  });

  it("honors shadowAlpha 0 (no shadow overlay)", () => {
    const image = compositeSurfaceImage(
      {
        color: colorBuffer(1, 1),
        objectId: ownerBuffer(1, 1, NO_OWNER),
        visibility: visibilityBuffer(1, 1, 0),
      },
      { shadowAlpha: 0 },
    );
    expect(image.data[0]).toBe(12);
    expect(image.data[3]).toBe(0);
  });

  it("defaults surface pixels when no visibility buffer is given", () => {
    const color = colorBuffer(1, 1);
    color.set(0, 0, 0, 9);
    color.set(0, 0, 1, 8);
    color.set(0, 0, 2, 7);
    color.set(0, 0, 3, 255);
    const image = compositeSurfaceImage({
      color,
      objectId: ownerBuffer(1, 1, 0),
      visibility: null,
    });
    expect(image.data[3]).toBe(255);
  });

  it("throws when buffer sizes disagree", () => {
    expect(() =>
      compositeSurfaceImage({
        color: colorBuffer(2, 1),
        objectId: ownerBuffer(3, 1, 0),
        visibility: null,
      }),
    ).toThrow(RangeError);
    expect(() =>
      compositeSurfaceImage({
        color: colorBuffer(2, 1),
        objectId: ownerBuffer(2, 1, 0),
        visibility: visibilityBuffer(2, 2, 1),
      }),
    ).toThrow(RangeError);
  });

  it("treats a visibility >= 0.5 as lit for the base plane", () => {
    const image = compositeSurfaceImage({
      color: colorBuffer(1, 1),
      objectId: ownerBuffer(1, 1, NO_OWNER),
      visibility: visibilityBuffer(1, 1, 0.5),
    });
    expect(image.data[3]).toBe(0);
  });
});
