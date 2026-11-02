package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo"
)

const desktopLogMaxSize int64 = 2 << 20
const desktopLogRetentionDays = 14

var logURLs = regexp.MustCompile(`(?i)\b(?:https?|file|mygo)://[^\s<>"']+`)
var logHeaders = regexp.MustCompile(`(?i)\b(?:authorization|set-cookie|cookie)\s*[:=].*`)
var logSecrets = regexp.MustCompile(`(?i)\b(token|refresh_?token|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?[^\s,;"'}]+`)
var logJWT = regexp.MustCompile(`[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`)
var ownedLogName = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(?:\.previous)?\.log$`)

func safeLogMessage(message string) string {
	message = strings.ToValidUTF8(message, "\uFFFD")
	message = logURLs.ReplaceAllStringFunc(message, func(value string) string {
		parsed, err := url.Parse(value)
		if err != nil || parsed.Host == "" {
			return "[url]"
		}
		return parsed.Scheme + "://" + parsed.Host + "/…"
	})
	message = logHeaders.ReplaceAllString(message, "[credentials redacted]")
	message = logSecrets.ReplaceAllString(message, "$1=[redacted]")
	message = logJWT.ReplaceAllString(message, "[token redacted]")
	return strings.TrimSpace(strings.Map(func(value rune) rune {
		if value < 32 || value == 127 {
			return ' '
		}
		return value
	}, message))
}

type dailyLogWriter struct {
	mu        sync.Mutex
	directory string
	now       func() time.Time
	maxSize   int64
	file      *os.File
	day       string
	size      int64
	closed    bool
}

func newDailyLogWriter(directory string) (*dailyLogWriter, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("invalid log directory")
	}
	return &dailyLogWriter{directory: directory, now: time.Now, maxSize: desktopLogMaxSize}, nil
}

func (w *dailyLogWriter) open(day string) error {
	path := filepath.Join(w.directory, day+".log")
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return errors.New("invalid log file")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return err
	}
	w.file, w.day, w.size = file, day, info.Size()
	return nil
}

func (w *dailyLogWriter) prune(now time.Time) {
	entries, err := os.ReadDir(w.directory)
	if err != nil {
		return
	}
	cutoff := now.UTC().AddDate(0, 0, -desktopLogRetentionDays).Format("2006-01-02")
	for _, entry := range entries {
		if entry.Type().IsRegular() && ownedLogName.MatchString(entry.Name()) && entry.Name()[:10] < cutoff {
			_ = os.Remove(filepath.Join(w.directory, entry.Name()))
		}
	}
}

func (w *dailyLogWriter) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return 0, os.ErrClosed
	}
	originalLength := len(data)
	line := safeLogMessage(string(data))
	if len(line) > 8192 {
		line = line[:8192]
		for !utf8.ValidString(line) {
			line = line[:len(line)-1]
		}
		line += "…"
	}
	line += "\n"
	now := w.now()
	day := now.UTC().Format("2006-01-02")
	if w.file == nil || w.day != day {
		if w.file != nil {
			_ = w.file.Close()
			w.file = nil
		}
		if err := w.open(day); err != nil {
			return 0, err
		}
		w.prune(now)
	}
	if w.size > 0 && w.size+int64(len(line)) > w.maxSize {
		if err := w.file.Close(); err != nil {
			w.file = nil
			return 0, err
		}
		w.file = nil
		previous := filepath.Join(w.directory, day+".previous.log")
		if err := os.Remove(previous); err != nil && !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
		if err := os.Rename(filepath.Join(w.directory, day+".log"), previous); err != nil {
			return 0, err
		}
		if err := w.open(day); err != nil {
			return 0, err
		}
	}
	n, err := io.WriteString(w.file, line)
	w.size += int64(n)
	if err != nil {
		return 0, err
	}
	return originalLength, nil
}

func (w *dailyLogWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	if w.file == nil {
		return nil
	}
	return errors.Join(w.file.Sync(), w.file.Close())
}

func configureDesktopLogging() (func(), error) {
	directory, err := mygo.App.Path(mygo.PathLogs)
	if err != nil {
		return nil, err
	}
	writer, err := newDailyLogWriter(filepath.Join(directory, "mygo"))
	if err != nil {
		return nil, err
	}
	previous := log.Writer()
	log.SetOutput(io.MultiWriter(previous, writer))
	return func() { log.SetOutput(previous); _ = writer.Close() }, nil
}

// Renderer logging accepts bounded strings, never arbitrary objects, errors with
// response bodies, credentials, local file references or native handles.
type DesktopLog struct {
	mu     sync.Mutex
	owner  context.Context
	window time.Time
	count  int
}

func init() { mygo.Bind(&DesktopLog{}) }

func (l *DesktopLog) Write(ctx context.Context, level, message string) error {
	if level != "info" && level != "warn" && level != "error" {
		return errors.New("invalid log level")
	}
	if len(message) > 4096 {
		return errors.New("log message too long")
	}
	if err := desktopLifecycle.call(ctx, false, func() error { return nil }); err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	now := time.Now()
	if l.owner != ctx || now.Sub(l.window) >= time.Minute {
		l.owner, l.window, l.count = ctx, now, 0
	}
	if l.count >= 120 {
		return nil
	}
	l.count++
	log.Printf("[renderer/%s] %s", level, safeLogMessage(message))
	return nil
}
