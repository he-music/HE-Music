//go:build linux

package main

func nativeDeviceModel() string {
	for _, path := range []string{"/sys/class/dmi/id/product_name", "/sys/firmware/devicetree/base/model"} {
		if model := normalizeDeviceModel(readDeviceModelFile(path), ""); model != "" {
			return model
		}
	}
	return ""
}
func nativeDeviceFallback() string { return "Linux PC" }
