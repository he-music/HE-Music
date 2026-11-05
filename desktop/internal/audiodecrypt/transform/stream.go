// 流变换执行逻辑改编自 pkg/um/qmc 与 pkg/um/mg；来源和许可证见 ../README.md。
package transform

import (
	"bytes"
	"errors"
	"io"
)

// 使用 64 位偏移计算索引，兼容 WASM 的 32 位 int；限制也避免浮点跳过量溢出。
const maxOffset int64 = 1 << 40

type streamReader struct {
	reader io.Reader
	params Parameters
	offset int64
}

func NewReader(reader io.Reader, params Parameters, offset int64) (io.Reader, error) {
	if err := params.Validate(); err != nil {
		return nil, err
	}
	if reader == nil || params.Kind == SampleCTR || offset < 0 || offset > maxOffset {
		return nil, errors.New("invalid audio stream")
	}
	return &streamReader{reader: reader, params: params, offset: offset}, nil
}

func (s *streamReader) Read(data []byte) (int, error) {
	n, err := s.reader.Read(data)
	if n == 0 {
		return n, err
	}
	if int64(n) > maxOffset-s.offset {
		return 0, errors.New("audio offset too large")
	}
	s.transform(data[:n])
	s.offset += int64(n)
	return n, err
}

func (s *streamReader) transform(data []byte) {
	p := &s.params
	switch p.Kind {
	case Subtract:
		for i := range data {
			data[i] -= p.Key[(s.offset+int64(i))%int64(len(p.Key))]
		}
	case Indexed:
		for i := range data {
			offset := s.offset + int64(i)
			if offset > int64(p.Period) {
				offset %= int64(p.Period)
			}
			index := (offset*offset + int64(p.Bias)) % int64(len(p.Key))
			data[i] ^= p.Key[index]
		}
	case Segmented:
		offset := s.offset
		if offset < int64(p.First) {
			n := min(len(data), p.First-int(offset))
			for i := range n {
				data[i] ^= p.Key[segmentSkip(p, offset+int64(i))]
			}
			data, offset = data[n:], offset+int64(n)
		}
		for len(data) > 0 {
			n := min(len(data), p.Segment-int(offset%int64(p.Segment)))
			box := bytes.Clone(p.Box)
			j, k := 0, 0
			skip := int(offset%int64(p.Segment)) + segmentSkip(p, offset/int64(p.Segment))
			for i := -skip; i < n; i++ {
				j = (j + 1) % len(box)
				k = (k + int(box[j])) % len(box)
				box[j], box[k] = box[k], box[j]
				if i >= 0 {
					data[i] ^= box[(int(box[j])+int(box[k]))%len(box)]
				}
			}
			data, offset = data[n:], offset+int64(n)
		}
	}
}

func segmentSkip(p *Parameters, id int64) int {
	seed := p.Key[id%int64(len(p.Key))]
	index := int64(float64(p.Hash) / (float64(id+1) * float64(seed)) * 100.0)
	return int(index % int64(len(p.Key)))
}
