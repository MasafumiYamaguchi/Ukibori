;; #33 ukibori normal-generation kernel — human-audit WAT listing.
;;
;; THIS FILE IS DOCUMENTATION ONLY. The actual binary is emitted by
;; scripts/build-wasm.mjs (the structured module spec there is the SOURCE OF
;; TRUTH; scripts/build-wasm.mjs --emit regenerates the checked-in base64 in
;; normal-kernel.base64.ts, and src/wasm/determinism.test.ts pins the bytes).
;;
;; The instruction encodings below are the empirically verified opcodes (see
;; the opcode table comment in build-wasm.mjs); every f64 operation mirrors
;; the TypeScript oracle computeNormals (packages/renderer/src/lighting.ts)
;; op-for-op, including the V8 Math.hypot replication (max-scaled sqrt of
;; squared ratios, argument order a, b, c), so the f32 output is bit-identical
;; to the oracle on the engines that run this repo's tests and browser gates.

(module
  (memory (export "memory") 1 65536)

  ;; Returns the kernel ABI version (1).
  (func (export "kernel_version") (result i32)
    i32.const 1)

  ;; Computes the normal field for a width*height f32 height field.
  ;;
  ;; Params:  width (i32), height (i32), scaleX (f64), scaleY (f64),
  ;;          normalScale (f64 > 0)
  ;; Memory:  height texels at byte offset 0 (row-major f32)
  ;;          output f32 xyz triples at byte offset 4*width*height
  ;; Returns: 0 on success; traps on out-of-bounds memory access.
  ;;
  ;; Per texel (x, y):
  ;;   x0 = max(x - 1, 0);  x1 = min(x + 1, width - 1)
  ;;   y0 = max(y - 1, 0);  y1 = min(y + 1, height - 1)
  ;;   dx = H(x1, y) - H(x0, y)        (f64 subtraction of f32 reads)
  ;;   dy = H(x, y1) - H(x, y0)
  ;;   nx = -dx * scaleX; ny = -dy * scaleY; nz = normalScale
  ;;   m  = max(|nx|, |ny|, |nz|); inv = 1 / m
  ;;   a = nx * inv; b = ny * inv; c = nz * inv
  ;;   m2 = max(|a|, |b|, |c|)
  ;;   len = m2 == 0 ? 0 : m2 * sqrt((a/m2)^2 + (b/m2)^2 + (c/m2)^2)
  ;;   N = (a / len, b / len, c / len) stored as f32
  (func (export "compute_normals") (param $w i32) (param $h i32)
        (param $sx f64) (param $sy f64) (param $nz f64) (result i32)
    (local $n i32)    ;; 5  texel count
    (local $g i32)    ;; 6  global texel index
    (local $tx i32)   ;; 7
    (local $ty i32)   ;; 8
    (local $x0 i32)   ;; 9
    (local $x1 i32)   ;; 10
    (local $y0 i32)   ;; 11
    (local $y1 i32)   ;; 12
    (local $row i32)  ;; 13
    (local $row0 i32) ;; 14
    (local $row1 i32) ;; 15
    (local $dx f64)   ;; 16
    (local $dy f64)   ;; 17
    (local $nx f64)   ;; 18
    (local $ny f64)   ;; 19
    (local $a f64)    ;; 20
    (local $b f64)    ;; 21
    (local $c f64)    ;; 22
    (local $m f64)    ;; 23
    (local $inv f64)  ;; 24
    (local $m2 f64)   ;; 25
    (local $sum f64)  ;; 26
    (local $t f64)    ;; 27  temp / len (reused; live ranges do not overlap)

    local.get $w
    local.get $h
    i32.mul
    local.set $n

    (block $exit
      (loop $pixels
        local.get $g
        local.get $n
        i32.ge_u
        br_if $exit

        local.get $g
        local.get $w
        i32.rem_u
        local.set $tx
        local.get $g
        local.get $w
        i32.div_u
        local.set $ty

        ;; x0 = tx > 0 ? tx - 1 : 0
        local.get $tx
        i32.const 1
        i32.ge_u
        if (result i32)
          local.get $tx
          i32.const 1
          i32.sub
        else
          i32.const 0
        end
        local.set $x0

        ;; x1 = min(tx + 1, width - 1)
        local.get $tx
        i32.const 1
        i32.add
        local.get $w
        i32.const 1
        i32.sub
        i32.lt_u
        if (result i32)
          local.get $tx
          i32.const 1
          i32.add
        else
          local.get $w
          i32.const 1
          i32.sub
        end
        local.set $x1

        ;; y0 = ty > 0 ? ty - 1 : 0
        local.get $ty
        i32.const 1
        i32.ge_u
        if (result i32)
          local.get $ty
          i32.const 1
          i32.sub
        else
          i32.const 0
        end
        local.set $y0

        ;; y1 = min(ty + 1, height - 1)
        local.get $ty
        i32.const 1
        i32.add
        local.get $h
        i32.const 1
        i32.sub
        i32.lt_u
        if (result i32)
          local.get $ty
          i32.const 1
          i32.add
        else
          local.get $h
          i32.const 1
          i32.sub
        end
        local.set $y1

        local.get $ty
        local.get $w
        i32.mul
        local.set $row
        local.get $y0
        local.get $w
        i32.mul
        local.set $row0
        local.get $y1
        local.get $w
        i32.mul
        local.set $row1

        ;; dx = H[row + x1] - H[row + x0]
        local.get $row
        local.get $x1
        i32.add
        i32.const 2
        i32.shl
        f32.load align=2 offset=0
        f64.promote_f32
        local.get $row
        local.get $x0
        i32.add
        i32.const 2
        i32.shl
        f32.load align=2 offset=0
        f64.promote_f32
        f64.sub
        local.set $dx

        ;; dy = H[row1 + tx] - H[row0 + tx]
        local.get $row1
        local.get $tx
        i32.add
        i32.const 2
        i32.shl
        f32.load align=2 offset=0
        f64.promote_f32
        local.get $row0
        local.get $tx
        i32.add
        i32.const 2
        i32.shl
        f32.load align=2 offset=0
        f64.promote_f32
        f64.sub
        local.set $dy

        ;; nx = -dx * scaleX ; ny = -dy * scaleY
        local.get $dx
        f64.neg
        local.get $sx
        f64.mul
        local.set $nx
        local.get $dy
        f64.neg
        local.get $sy
        f64.mul
        local.set $ny

        ;; m = max(|nx|, |ny|, normalScale) ; inv = 1 / m
        local.get $nx
        f64.abs
        local.get $ny
        f64.abs
        f64.max
        local.get $nz
        f64.max
        local.set $m
        f64.const 1
        local.get $m
        f64.div
        local.set $inv

        ;; a = nx * inv ; b = ny * inv ; c = normalScale * inv
        local.get $nx
        local.get $inv
        f64.mul
        local.set $a
        local.get $ny
        local.get $inv
        f64.mul
        local.set $b
        local.get $nz
        local.get $inv
        f64.mul
        local.set $c

        ;; m2 = max(|a|, |b|, |c|)
        local.get $a
        f64.abs
        local.get $b
        f64.abs
        f64.max
        local.get $c
        f64.abs
        f64.max
        local.set $m2

        ;; len = m2 == 0 ? 0 : m2 * sqrt(sum((v / m2)^2)) — the exact V8
        ;; Math.hypot replication, in argument order a, b, c.
        f64.const 0
        local.set $t
        (block $skipLen
          local.get $m2
          f64.const 0
          f64.eq
          br_if $skipLen
          f64.const 0
          local.set $sum
          local.get $a
          local.get $m2
          f64.div
          local.tee $t
          local.get $t
          f64.mul
          local.get $sum
          f64.add
          local.set $sum
          local.get $b
          local.get $m2
          f64.div
          local.tee $t
          local.get $t
          f64.mul
          local.get $sum
          f64.add
          local.set $sum
          local.get $c
          local.get $m2
          f64.div
          local.tee $t
          local.get $t
          f64.mul
          local.get $sum
          f64.add
          local.set $sum
          local.get $m2
          local.get $sum
          f64.sqrt
          f64.mul
          local.set $t
        )

        ;; out[g*3 + 0] = a / len ; +1 = b / len ; +2 = c / len
        ;; base byte offset 4 * n ; address pushed first, then the value.
        local.get $n
        local.get $g
        i32.const 3
        i32.mul
        i32.add
        i32.const 2
        i32.shl
        i32.const 0
        i32.add
        local.get $a
        local.get $t
        f64.div
        f32.demote_f64
        f32.store align=2 offset=0

        local.get $n
        local.get $g
        i32.const 3
        i32.mul
        i32.add
        i32.const 2
        i32.shl
        i32.const 4
        i32.add
        local.get $b
        local.get $t
        f64.div
        f32.demote_f64
        f32.store align=2 offset=0

        local.get $n
        local.get $g
        i32.const 3
        i32.mul
        i32.add
        i32.const 2
        i32.shl
        i32.const 8
        i32.add
        local.get $c
        local.get $t
        f64.div
        f32.demote_f64
        f32.store align=2 offset=0

        local.get $g
        i32.const 1
        i32.add
        local.set $g
        br $pixels
      )
    )

    i32.const 0)
