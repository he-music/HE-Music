package metadata

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func TestValidateAudioPayload(t *testing.T) {
	for name, data := range map[string][]byte{
		"mp3": payloadMP3(), "flac": payloadFLAC(), "mac": formatsMACFixture(),
	} {
		t.Run(name, func(t *testing.T) { checkSinglePayload(t, data) })
	}
	for _, suffix := range []string{"wav", "aiff", "aac", "m4a", "ogg", "webm"} {
		t.Run(suffix, func(t *testing.T) {
			checkSinglePayload(t, mustRead(t, formatsFixture(t, suffix)))
		})
	}
}

func checkSinglePayload(t *testing.T, data []byte) {
	t.Helper()
	size := int64(len(data))
	measured := &payloadGuardReader{data: data}
	if err := ValidateAudioPayload(t.Context(), measured, size); err != nil {
		t.Fatal(err)
	}
	if measured.calls == 0 || measured.maxRead > 32<<10 {
		t.Fatalf("unbounded or missing reads: %+v", measured)
	}
	left, right := &payloadGuardReader{data: data}, &payloadGuardReader{data: data}
	if err := CompareAudioPayload(t.Context(), left, size, right, size); err != nil {
		t.Fatal(err)
	}
	if measured.calls != left.calls || right.calls == 0 || measured.calls >= left.calls+right.calls {
		t.Fatalf("single=%d left=%d right=%d", measured.calls, left.calls, right.calls)
	}
	// Even identical reader values must still be independently read by comparison.
	same := &payloadGuardReader{data: data}
	if err := CompareAudioPayload(t.Context(), same, size, same, size); err != nil {
		t.Fatal(err)
	}
	if same.calls != left.calls+right.calls {
		t.Fatalf("same reader skipped validation: %d != %d + %d", same.calls, left.calls, right.calls)
	}
	for at := 1; at <= measured.calls; at++ {
		ctx, cancel := context.WithCancel(t.Context())
		reader := &payloadGuardReader{data: data, cancel: cancel, cancelAt: at}
		err := ValidateAudioPayload(ctx, reader, size)
		cancel()
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel at read %d: %v", at, err)
		}
	}
	for _, malformed := range [][]byte{data[:len(data)-1], append(bytes.Clone(data), 0)} {
		old := CompareAudioPayload(t.Context(), bytes.NewReader(malformed), int64(len(malformed)), bytes.NewReader(malformed), int64(len(malformed)))
		got := ValidateAudioPayload(t.Context(), bytes.NewReader(malformed), int64(len(malformed)))
		for _, category := range []error{ErrInvalidPayload, ErrUnsupportedPayload, ErrAudioPayloadChanged} {
			if errors.Is(old, category) != errors.Is(got, category) {
				t.Fatalf("error category changed: old=%v single=%v", old, got)
			}
		}
		if (old == nil) != (got == nil) {
			t.Fatalf("acceptance changed: old=%v single=%v", old, got)
		}
	}
}

func TestValidateAudioPayloadInvalidAndCanceled(t *testing.T) {
	data := payloadMP3()
	reader := &payloadGuardReader{data: data}
	if err := ValidateAudioPayload(t.Context(), nil, 1); !errors.Is(err, ErrInvalidPayload) {
		t.Fatal(err)
	}
	for _, size := range []int64{-1, 0} {
		if err := ValidateAudioPayload(t.Context(), reader, size); !errors.Is(err, ErrUnsupportedPayload) {
			t.Fatalf("size %d: %v", size, err)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := ValidateAudioPayload(ctx, reader, int64(len(data))); !errors.Is(err, context.Canceled) || reader.calls != 0 {
		t.Fatalf("cancel before IO: %v reads=%d", err, reader.calls)
	}
	reader.fail = true
	if err := ValidateAudioPayload(t.Context(), reader, int64(len(data))); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("read failure: %v", err)
	}
	for _, data := range [][]byte{payloadMP3(), payloadFLAC()} {
		for cut := range data {
			if err := ValidateAudioPayload(t.Context(), bytes.NewReader(data[:cut]), int64(cut)); err == nil {
				t.Fatalf("accepted truncation at %d/%d", cut, len(data))
			}
		}
	}
}
