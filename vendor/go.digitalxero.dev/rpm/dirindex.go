package rpm

// dirIndex maps directory names to their position in the DIRNAMES array,
// preserving first-seen order so DIRINDEXES is deterministic.
type dirIndex struct {
	lookup map[string]int32
	dirs   []string
}

func newDirIndex() *dirIndex {
	return &dirIndex{lookup: map[string]int32{}}
}

// get returns the index of dir, assigning a new one on first use.
func (d *dirIndex) get(dir string) int32 {
	if i, ok := d.lookup[dir]; ok {
		return i
	}
	i := int32(len(d.dirs))
	d.dirs = append(d.dirs, dir)
	d.lookup[dir] = i
	return i
}

func (d *dirIndex) all() []string { return d.dirs }
