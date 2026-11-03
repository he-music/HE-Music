package mtag

type textValueReader interface {
	Get(string) string
}

type textValueWriter interface {
	Set(string, string)
}

type multiTextValueReader interface {
	GetAll(string) []string
}

type multiTextValueWriter interface {
	setAll(string, []string)
}

func firstMappedValue(r textValueReader, names ...string) string {
	if r == nil {
		return ""
	}
	for _, name := range names {
		if name == "" {
			continue
		}
		if s := r.Get(name); s != "" {
			return s
		}
	}
	return ""
}

func firstMappedValues(r multiTextValueReader, names ...string) []string {
	if r == nil {
		return nil
	}
	for _, name := range names {
		if name == "" {
			continue
		}
		if vals := r.GetAll(name); len(vals) > 0 {
			return append([]string(nil), vals...)
		}
	}
	return nil
}

func setMappedPrimary(w textValueWriter, names []string, value string) bool {
	if w == nil || len(names) == 0 || names[0] == "" {
		return false
	}
	w.Set(names[0], value)
	for _, alias := range names[1:] {
		if alias == "" {
			continue
		}
		w.Set(alias, "")
	}
	return true
}

func setMappedAll(w multiTextValueWriter, names []string, values []string) bool {
	if w == nil || len(names) == 0 || names[0] == "" {
		return false
	}
	w.setAll(names[0], values)
	for _, alias := range names[1:] {
		if alias == "" {
			continue
		}
		w.setAll(alias, nil)
	}
	return true
}
