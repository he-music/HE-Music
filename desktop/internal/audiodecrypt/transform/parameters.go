// Package transform 执行主服务预计算的音频变换参数，不解析平台原始密钥。
package transform

import (
	"encoding/base64"
	"encoding/json/v2"
	"errors"
	"slices"
	"strings"
)

const (
	Version        = 1
	MaxEncodedSize = 16 << 10
	Subtract       = 1
	Indexed        = 2
	Segmented      = 3
	SampleCTR      = 4
)

// Parameters 是无平台标识的执行协议；Key/Box 是已准备好的材料。
// 参数可被客户端读取，不用于提供密钥保密或访问授权。
type Parameters struct {
	Version   int    `json:"v"`
	Kind      int    `json:"kind"`
	Key       []byte `json:"key"`
	Box       []byte `json:"box,omitempty"`
	Hash      uint32 `json:"hash,omitzero"`
	Period    int    `json:"period,omitzero"`
	Bias      int    `json:"bias,omitzero"`
	First     int    `json:"first,omitzero"`
	Segment   int    `json:"segment,omitzero"`
	UserAgent string `json:"user_agent,omitempty"`
}

func (p Parameters) Validate() error {
	if p.Version != Version || len(p.Key) == 0 || len(p.Key) > 4096 || len(p.UserAgent) > 256 || strings.ContainsAny(p.UserAgent, "\r\n\x00") || !p.validKind() {
		return errors.New("invalid audio parameters")
	}
	return nil
}

func (p Parameters) validKind() bool {
	switch p.Kind {
	case Subtract:
		return p.validUnsegmented() && p.Period == 0 && p.Bias == 0
	case Indexed:
		return p.validIndexed()
	case Segmented:
		return p.validSegmented()
	case SampleCTR:
		return p.validUnsegmented() && p.Period == 0 && p.Bias == 0 && slices.Contains([]int{16, 24, 32}, len(p.Key))
	default:
		return false
	}
}

func (p Parameters) validUnsegmented() bool {
	return len(p.Box) == 0 && p.Hash == 0 && p.First == 0 && p.Segment == 0
}

func (p Parameters) validIndexed() bool {
	return p.validUnsegmented() && p.Period >= 1 && p.Period <= 1<<20 && p.Bias >= 0 && p.Bias <= 1<<20
}

func (p Parameters) validSegmented() bool {
	// 分段跳过量以 key 字节为除数，零值会产生无效索引。
	return len(p.Key) == len(p.Box) && p.Hash != 0 && p.Segment >= 1 && p.Segment <= 1<<20 && p.First >= 0 && p.First <= p.Segment && p.Period == 0 && p.Bias == 0 && !slices.Contains(p.Key, byte(0))
}

func Encode(p Parameters) (string, error) {
	if err := p.Validate(); err != nil {
		return "", err
	}
	data, err := json.Marshal(p)
	if err != nil {
		return "", errors.New("could not encode audio parameters")
	}
	encoded := base64.RawURLEncoding.EncodeToString(data)
	if len(encoded) > MaxEncodedSize {
		return "", errors.New("audio parameters too large")
	}
	return encoded, nil
}

func Parse(encoded string) (Parameters, error) {
	var p Parameters
	if len(encoded) == 0 || len(encoded) > MaxEncodedSize {
		return p, errors.New("invalid audio parameters")
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return p, errors.New("invalid audio parameters")
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return Parameters{}, errors.New("invalid audio parameters")
	}
	if err := p.Validate(); err != nil {
		return Parameters{}, err
	}
	return p, nil
}
