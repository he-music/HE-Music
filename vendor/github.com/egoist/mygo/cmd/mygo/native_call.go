package main

import (
	"bytes"
	"fmt"
	"go/format"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/egoist/mygo/internal/nativegen"
)

// runNativeCall makes the implementation of an entry point and calls one
// of its methods, through a small Go program it writes into the module,
// which decodes the arguments into the method's parameters and prints the
// results as JSON.
func runNativeCall(args []string) error {
	fs := newFlags("native call", "[-timeout <duration>] [module dir] <Interface>.<Method> [<arguments>]", `Makes the implementation of an entry point, calls one method with
<arguments>, a JSON object of its parameters by their Go names, and prints
the result as JSON, a line per value of a stream. It makes the method's
context, which -timeout limits, and prints the calls of callbacks. A method
returning an io.Closer runs until -timeout, then closes it. A *native.Buffer
argument is its size, and its contents print after the result.`)
	timeout := fs.Duration("timeout", 10*time.Second, "how long the call, a stream or a subscription may last")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	dir := "."
	if len(rest) > 0 && !strings.Contains(rest[0], ".") || len(rest) > 1 && !strings.HasPrefix(strings.TrimSpace(rest[1]), "{") && strings.Contains(rest[1], ".") {
		dir, rest = rest[0], rest[1:]
	}
	if len(rest) == 0 || len(rest) > 2 {
		fs.Usage()
		return errSilent
	}
	iface, method, ok := strings.Cut(rest[0], ".")
	if !ok {
		return fmt.Errorf("%q is not <Interface>.<Method>, such as Analyzer.DetectLanguage", rest[0])
	}
	argJSON := "{}"
	if len(rest) == 2 {
		argJSON = rest[1]
	}
	if _, err := nativegen.Generate(dir); err != nil {
		return err
	}
	m, err := nativegen.Load(dir)
	if err != nil {
		return err
	}
	var it *nativegen.Interface
	var me *nativegen.Method
	for _, x := range m.Interfaces {
		if x.Name == iface {
			it = x
		}
	}
	if it == nil || !it.Entry {
		var names []string
		for _, x := range m.Interfaces {
			if x.Entry {
				names = append(names, x.Name)
			}
		}
		return fmt.Errorf("%s is not an entry point of the module, which are: %s", iface, strings.Join(names, ", "))
	}
	for _, x := range it.Methods {
		if x.Name == method {
			me = x
		}
	}
	if me == nil {
		return fmt.Errorf("%s has no method %s", iface, method)
	}
	if runtime.GOOS == "darwin" && nativegen.HasLang(dir, "swift") {
		if _, err := buildSwiftModule(dir, runtime.GOARCH, false); err != nil {
			return err
		}
	}
	src, err := callProgram(m, it, me, *timeout)
	if err != nil {
		return err
	}
	work, err := os.MkdirTemp(m.Dir, ".mygo-call-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	main := filepath.Join(work, "main.go")
	if err := os.WriteFile(main, src, 0o644); err != nil {
		return err
	}
	cmd := goCommand(m.Dir, nil, "run", main, argJSON)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if _, ok := err.(*exec.ExitError); ok {
			return errSilent
		}
		return err
	}
	return nil
}

// callType spells a type in the program that calls the module, whose
// package it imports as m.
func callType(t *nativegen.Type) string {
	switch t.Kind {
	case nativegen.StructType, nativegen.EnumType, nativegen.InterfaceType:
		return "m." + t.Name
	case nativegen.Slice:
		return "[]" + callType(t.Elem)
	case nativegen.Map:
		return "map[string]" + callType(t.Elem)
	case nativegen.Pointer:
		return "*" + callType(t.Elem)
	case nativegen.Buffer:
		return "int"
	}
	return t.Go
}

func callProgram(mod *nativegen.Module, it *nativegen.Interface, me *nativegen.Method, timeout time.Duration) ([]byte, error) {
	var path bytes.Buffer
	cmd := goCommand(mod.Dir, nil, "list", "-f", "{{.ImportPath}}", ".")
	cmd.Stdout = &path
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("go list %s: %v", mod.Dir, err)
	}
	var b strings.Builder
	fmt.Fprintf(&b, `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/egoist/mygo/native"
	m %q
)

var _ = io.EOF
var _ = time.Second
var _ = native.ErrClosed

func out(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		fail(err)
	}
	fmt.Println(string(b))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), %d)
	defer cancel()
	_ = ctx
	v, err := m.New%s()
	if err != nil {
		fail(err)
	}
	var a struct {
`, strings.TrimSpace(path.String()), int64(timeout), it.Name)
	var call []string
	if me.Ctx {
		call = append(call, "ctx")
	}
	var after []string
	for i, p := range me.Params {
		switch p.Type.Kind {
		case nativegen.InterfaceType, nativegen.Window:
			return nil, fmt.Errorf("%s.%s takes %s %s, which mygo native call cannot make: call it from a test", it.Name, me.Name, p.Name, p.Type.Go)
		case nativegen.Func:
			var ps, names []string
			for j, q := range p.Type.Params {
				ps = append(ps, fmt.Sprintf("q%d %s", j, callType(q.Type)))
				names = append(names, fmt.Sprintf("q%d", j))
			}
			res := ""
			ret := ""
			switch {
			case p.Type.Result != nil && p.Type.Err:
				res, ret = " ("+callType(p.Type.Result)+", error)", "var z "+callType(p.Type.Result)+"\nreturn z, nil"
			case p.Type.Result != nil:
				res, ret = " "+callType(p.Type.Result), "var z "+callType(p.Type.Result)+"\nreturn z"
			case p.Type.Err:
				res, ret = " error", "return nil"
			}
			after = append(after, fmt.Sprintf("f%d := func(%s)%s {\nout(map[string]any{\"callback\": %q, \"args\": []any{%s}})\n%s\n}", i, strings.Join(ps, ", "), res, p.Name, strings.Join(names, ", "), ret))
			call = append(call, fmt.Sprintf("f%d", i))
		case nativegen.Buffer:
			fmt.Fprintf(&b, "\tP%d int `json:%q`\n", i, p.Name)
			after = append(after, fmt.Sprintf("buf%d := native.NewBuffer(a.P%d)", i, i))
			call = append(call, fmt.Sprintf("buf%d", i))
		default:
			fmt.Fprintf(&b, "\tP%d %s `json:%q`\n", i, callType(p.Type), p.Name)
			call = append(call, fmt.Sprintf("a.P%d", i))
		}
	}
	b.WriteString("}\n")
	fmt.Fprintf(&b, "if err := json.Unmarshal([]byte(os.Args[1]), &a); err != nil {\nfail(fmt.Errorf(\"the arguments: %%w\", err))\n}\n")
	for _, s := range after {
		b.WriteString(s + "\n")
	}
	c := "v." + me.Name + "(" + strings.Join(call, ", ") + ")"
	switch {
	case me.Stream == 2:
		fmt.Fprintf(&b, "for x, err := range %s {\nif err != nil {\nfail(err)\n}\nout(x)\n}\n", c)
	case me.Stream == 1:
		fmt.Fprintf(&b, "for x := range %s {\nout(x)\n}\n", c)
	case me.Closer:
		fmt.Fprintf(&b, "sub := %s\n<-ctx.Done()\nif err := sub.Close(); err != nil {\nfail(err)\n}\n", c)
	case me.Result != nil && me.Result.Kind == nativegen.InterfaceType:
		if me.Err {
			fmt.Fprintf(&b, "r, err := %s\nif err != nil {\nfail(err)\n}\n", c)
		} else {
			fmt.Fprintf(&b, "r := %s\n", c)
		}
		fmt.Fprintf(&b, "out(map[string]any{\"object\": %q, \"nil\": r == nil})\n", me.Result.Name)
	case me.Result != nil && me.Err:
		fmt.Fprintf(&b, "r, err := %s\nif err != nil {\nfail(err)\n}\nout(r)\n", c)
	case me.Result != nil:
		fmt.Fprintf(&b, "out(%s)\n", c)
	case me.Err:
		fmt.Fprintf(&b, "if err := %s; err != nil {\nfail(err)\n}\n", c)
	default:
		b.WriteString(c + "\n")
	}
	for i, p := range me.Params {
		if p.Type.Kind == nativegen.Buffer {
			fmt.Fprintf(&b, "out(map[string]any{%q: string(buf%d.Bytes())})\n", p.Name, i)
		}
	}
	b.WriteString("native.Flush()\n}\n")
	src, err := format.Source([]byte(b.String()))
	if err != nil {
		return nil, fmt.Errorf("mygo native call: %v\n%s", err, b.String())
	}
	return src, nil
}
