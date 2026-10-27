//go:build nativeprobe

package main

import (
	"encoding/json"

	"github.com/egoist/mygo"
)

// Checkpoints flush queued error tasks without retaining error messages or payloads.
func nativeDiagnosticCheckpoint(win *mygo.Window, stage string) map[string]any {
	encoded, _ := json.Marshal(stage)
	value, err := win.Page().Eval(`(async () => {
  const p = window.__m2Probe;
  p.stage = ` + string(encoded) + `;
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  return { checkpointOK: true, stage: p.stage, errors: p.errors,
    rejections: p.rejections, resourceErrors: p.resourceErrors,
    categories: p.errorDiagnostics.map(item => item.category) };
})()`)
	if err != nil {
		return map[string]any{"checkpointOK": false, "stage": stage}
	}
	result, ok := value.(map[string]any)
	if !ok {
		return map[string]any{"checkpointOK": false, "stage": stage}
	}
	return result
}

func nativeDiagnosticRuntimeClean(result map[string]any) bool {
	return result["checkpointOK"] == true && result["errors"] == float64(0) &&
		result["rejections"] == float64(0) && result["resourceErrors"] == float64(0)
}
