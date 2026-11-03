//go:build !linux

package mtag

func copyPathXattrs(src, dst string) {}
