;; SIMD kernels for the value / policy nets (src/bot/nnwasm.js). Build: node scripts/build-wasm.js -> nnkern.wasm
;; All pointers are byte offsets into the exported memory, float32 vectors, n a multiple of 4.
(module
  (memory (export "memory") 16)

  ;; d[0..n) += a * s[0..n)
  (func $axpy (param $d i32) (param $s i32) (param $a f32) (param $n i32)
    (local $end i32) (local $av v128)
    (local.set $end (i32.add (local.get $d) (i32.shl (local.get $n) (i32.const 2))))
    (local.set $av (f32x4.splat (local.get $a)))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $d) (local.get $end)))
        (v128.store (local.get $d)
          (f32x4.add (v128.load (local.get $d)) (f32x4.mul (v128.load (local.get $s)) (local.get $av))))
        (local.set $d (i32.add (local.get $d) (i32.const 16)))
        (local.set $s (i32.add (local.get $s) (i32.const 16)))
        (br $l))))
  (export "axpy" (func $axpy))

  ;; d[0..n) = s[0..n)
  (func (export "copy") (param $d i32) (param $s i32) (param $n i32)
    (memory.copy (local.get $d) (local.get $s) (i32.shl (local.get $n) (i32.const 2))))

  ;; d[0..n) = a[0..n) + b[0..n)
  (func (export "add") (param $d i32) (param $a i32) (param $b i32) (param $n i32)
    (local $end i32)
    (local.set $end (i32.add (local.get $d) (i32.shl (local.get $n) (i32.const 2))))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $d) (local.get $end)))
        (v128.store (local.get $d) (f32x4.add (v128.load (local.get $a)) (v128.load (local.get $b))))
        (local.set $d (i32.add (local.get $d) (i32.const 16)))
        (local.set $a (i32.add (local.get $a) (i32.const 16)))
        (local.set $b (i32.add (local.get $b) (i32.const 16)))
        (br $l))))

  ;; pairs = cnt x (i32 row, f32 weight): d += weight * W[row]   (rows of `n` floats, rowBytes apart)
  (func (export "rows") (param $d i32) (param $W i32) (param $rowBytes i32) (param $pairs i32) (param $cnt i32) (param $n i32)
    (local $end i32)
    (local.set $end (i32.add (local.get $pairs) (i32.shl (local.get $cnt) (i32.const 3))))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $pairs) (local.get $end)))
        (call $axpy (local.get $d)
          (i32.add (local.get $W) (i32.mul (i32.load (local.get $pairs)) (local.get $rowBytes)))
          (f32.load offset=4 (local.get $pairs)) (local.get $n))
        (local.set $pairs (i32.add (local.get $pairs) (i32.const 8)))
        (br $l))))

  ;; indices k < n with x[k] > 0 -> idx (i32), returns the count
  (func (export "nz") (param $x i32) (param $n i32) (param $idx i32) (result i32)
    (local $k i32) (local $c i32)
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $k) (local.get $n)))
        (if (f32.gt (f32.load (i32.add (local.get $x) (i32.shl (local.get $k) (i32.const 2)))) (f32.const 0))
          (then
            (i32.store (i32.add (local.get $idx) (i32.shl (local.get $c) (i32.const 2))) (local.get $k))
            (local.set $c (i32.add (local.get $c) (i32.const 1)))))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $l)))
    (local.get $c))

  ;; for each k in idx[0..cnt): d += x[k] * WT[k]   (WT rows of `n` floats, rowBytes apart) - a matrix-vector
  ;; product over only the non-zero (post-ReLU) inputs
  (func (export "gather") (param $d i32) (param $WT i32) (param $rowBytes i32) (param $x i32) (param $idx i32) (param $cnt i32) (param $n i32)
    (local $end i32) (local $k i32)
    (local.set $end (i32.add (local.get $idx) (i32.shl (local.get $cnt) (i32.const 2))))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $idx) (local.get $end)))
        (local.set $k (i32.load (local.get $idx)))
        (call $axpy (local.get $d)
          (i32.add (local.get $WT) (i32.mul (local.get $k) (local.get $rowBytes)))
          (f32.load (i32.add (local.get $x) (i32.shl (local.get $k) (i32.const 2)))) (local.get $n))
        (local.set $idx (i32.add (local.get $idx) (i32.const 4)))
        (br $l))))

  ;; sum over k < n of max(x[k], 0) * w[k]
  (func (export "relu_dot") (param $x i32) (param $w i32) (param $n i32) (result f32)
    (local $end i32) (local $acc v128)
    (local.set $end (i32.add (local.get $x) (i32.shl (local.get $n) (i32.const 2))))
    (local.set $acc (v128.const f32x4 0 0 0 0))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $x) (local.get $end)))
        (local.set $acc (f32x4.add (local.get $acc)
          (f32x4.mul (f32x4.max (v128.load (local.get $x)) (v128.const f32x4 0 0 0 0)) (v128.load (local.get $w)))))
        (local.set $x (i32.add (local.get $x) (i32.const 16)))
        (local.set $w (i32.add (local.get $w) (i32.const 16)))
        (br $l)))
    (f32.add (f32.add (f32x4.extract_lane 0 (local.get $acc)) (f32x4.extract_lane 1 (local.get $acc)))
             (f32.add (f32x4.extract_lane 2 (local.get $acc)) (f32x4.extract_lane 3 (local.get $acc)))))
)
