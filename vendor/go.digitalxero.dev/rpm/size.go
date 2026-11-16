package rpm

// size.go centralizes the 32-bit vs 64-bit tag selection. RPM uses INT32 size
// tags by default and switches an entire family to its INT64 "LONG" form once a
// value (or, for per-file sizes, the largest element) exceeds 4 GiB-1. This makes
// packages larger than 4 GiB work without any caller involvement.

const uint32Max = 0xFFFFFFFF

// putScalarSize adds either the 32-bit tag or its 64-bit form depending on v.
func putScalarSize(idx *index, tag32, tag64 int, v uint64) {
	if v > uint32Max {
		idx.add(tag64, EntryUint64([]uint64{v}))
	} else {
		idx.add(tag32, EntryUint32([]uint32{uint32(v)}))
	}
}

// putFileSizes adds FILESIZES (INT32[]) or LONGFILESIZES (INT64[]) based on the
// largest file size; the whole array must use a single type.
func putFileSizes(idx *index, sizes []uint64) {
	if len(sizes) == 0 {
		return
	}
	var max uint64
	for _, s := range sizes {
		if s > max {
			max = s
		}
	}
	if max > uint32Max {
		idx.add(tagLongFileSizes, EntryUint64(sizes))
		return
	}
	u32 := make([]uint32, len(sizes))
	for i, s := range sizes {
		u32[i] = uint32(s)
	}
	idx.add(tagFileSizes, EntryUint32(u32))
}
