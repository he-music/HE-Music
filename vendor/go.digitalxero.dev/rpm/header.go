package rpm

import (
	"fmt"
	"sort"
)

// header.go populates the main (immutable, 0x3f) header index from the package
// state. It mirrors rpmpack's writeGenIndexes / writeFileIndexes /
// writeRelationIndexes and adds the tags rpmpack omits (triggers, changelog,
// weak deps, file capabilities/colors, source-package tags, rpmlib() requires).

func (p *rpmPackage) writeGenIndexes(h *index, fa *fileArrays, payloadDigest string) {
	h.add(tagHeaderI18NTable, EntryStringSlice([]string{"C"}))
	putScalarSize(h, tagSize, tagLongSize, fa.installedSize)
	h.add(tagName, EntryString(p.name))
	h.add(tagVersion, EntryString(p.version))
	h.add(tagRelease, EntryString(p.release))
	// RPM 6.0.1's Lua runner crashes when RPMVERSION is absent. Identify the
	// producer honestly rather than claiming an upstream rpmbuild version or
	// consulting host tools, which would make output environment-dependent.
	h.add(tagRPMVersion, EntryString("go.digitalxero.dev/rpm"))
	if p.epochSet {
		h.add(tagEpoch, EntryUint32([]uint32{p.epoch}))
	}
	h.add(tagSummary, EntryString(p.summary))
	h.add(tagDescription, EntryString(p.description))
	if !p.buildTime.IsZero() {
		h.add(tagBuildTime, EntryInt32([]int32{int32(p.buildTime.Unix())}))
	}
	h.add(tagBuildHost, EntryString(p.buildHost))
	h.add(tagLicense, EntryString(p.license))
	h.add(tagOS, EntryString(p.os))
	h.add(tagArch, EntryString(p.arch))
	if p.vendor != "" {
		h.add(tagVendor, EntryString(p.vendor))
	}
	if p.packager != "" {
		h.add(tagPackager, EntryString(p.packager))
	}
	if p.group != "" {
		h.add(tagGroup, EntryString(p.group))
	}
	if p.url != "" {
		h.add(tagURL, EntryString(p.url))
	}
	if p.distribution != "" {
		h.add(tagDistribution, EntryString(p.distribution))
	}
	if p.vcs != "" {
		h.add(tagVCS, EntryString(p.vcs))
	}
	if len(p.prefixes) > 0 {
		h.add(tagPrefixes, EntryStringSlice(p.prefixes))
	}
	if len(p.excludeArch) > 0 {
		h.add(tagExcludeArch, EntryStringSlice(p.excludeArch))
	}
	if len(p.exclusiveArch) > 0 {
		h.add(tagExclusiveArch, EntryStringSlice(p.exclusiveArch))
	}
	if len(p.excludeOS) > 0 {
		h.add(tagExcludeOS, EntryStringSlice(p.excludeOS))
	}
	if len(p.exclusiveOS) > 0 {
		h.add(tagExclusiveOS, EntryStringSlice(p.exclusiveOS))
	}
	if len(p.buildArchs) > 0 {
		h.add(tagBuildArchs, EntryStringSlice(p.buildArchs))
	}
	if p.optFlags != "" {
		h.add(tagOptFlags, EntryString(p.optFlags))
	}
	if p.platform != "" {
		h.add(tagPlatform, EntryString(p.platform))
	}
	h.add(tagPayloadFormat, EntryString("cpio"))
	h.add(tagPayloadCompressor, EntryString(p.compressor.name()))
	h.add(tagPayloadFlags, EntryString(p.compressor.flags()))
	h.add(tagPayloadDigest, EntryStringSlice([]string{payloadDigest}))
	// PAYLOADDIGESTALGO is a scalar (one algorithm for the whole payload), not a
	// per-file array.
	h.add(tagPayloadDigestAlgo, EntryInt32([]int32{int32(p.payloadDigestAlgo.rpmAlgo())}))

	// rpm uses the presence of SOURCERPM to mean "this is a binary package"; a
	// source package omits it and sets SOURCEPACKAGE instead (rpmpack PR #105).
	if p.sourcePackage {
		h.add(tagSourcePackage, EntryInt32([]int32{1}))
	} else {
		h.add(tagSourceRPM, EntryString(fmt.Sprintf("%s-%s.src.rpm", p.name, p.FullVersion())))
	}
}

func (p *rpmPackage) writeFileIndexes(h *index, fa *fileArrays) {
	h.add(tagDirNames, EntryStringSlice(fa.dirnames))
	h.add(tagDirIndexes, EntryInt32(fa.dirindexes))
	h.add(tagBasenames, EntryStringSlice(fa.basenames))
	putFileSizes(h, fa.sizes)
	h.add(tagFileModes, EntryUint16(fa.modes))
	h.add(tagFileRDevs, EntryInt16(fa.rdevs))
	h.add(tagFileMTimes, EntryInt32(fa.mtimes))
	h.add(tagFileDigests, EntryStringSlice(fa.digests))
	h.add(tagFileLinkTos, EntryStringSlice(fa.linktos))
	h.add(tagFileFlags, EntryInt32(fa.flags))
	h.add(tagFileUserName, EntryStringSlice(fa.usernames))
	h.add(tagFileGroupName, EntryStringSlice(fa.groupnames))
	h.add(tagFileVerifyFlags, EntryInt32(fa.verifyflags))
	h.add(tagFileDevices, EntryInt32(fa.devices))
	h.add(tagFileINodes, EntryInt32(fa.inodes))
	h.add(tagFileLangs, EntryStringSlice(fa.langs))
	// FILEDIGESTALGO is RPM_INT32_TYPE scalar (rpmtag.h: 5011 /* i */) — one
	// algorithm for all file digests, NOT a per-file array. (rpmpack writes a
	// per-file array, which rpm tolerates by reading element 0, but the scalar
	// form is the canonical one and is what rpm -K verifies against.)
	h.add(tagFileDigestAlgo, EntryInt32([]int32{int32(p.fileDigestAlgo.rpmAlgo())}))
	if fa.anyColors {
		h.add(tagFileColors, EntryInt32(fa.colors))
	}
	if fa.anyCaps {
		h.add(tagFileCaps, EntryStringSlice(fa.caps))
	}
}

func writeRelations(h *index, rels []*relation, nameTag, verTag, flagTag int) {
	if len(rels) == 0 {
		return
	}
	names := make([]string, len(rels))
	vers := make([]string, len(rels))
	flags := make([]int32, len(rels))
	for i, r := range rels {
		names[i] = r.name
		vers[i] = r.version
		flags[i] = int32(r.sense)
	}
	h.add(nameTag, EntryStringSlice(names))
	h.add(verTag, EntryStringSlice(vers))
	h.add(flagTag, EntryInt32(flags))
}

func (p *rpmPackage) writeRelationIndexes(h *index, provides, requires []*relation, fileCount int) {
	// requires already includes any file-level requires (merged in serialize);
	// append the rpmlib() feature requirements implied by the on-disk format.
	requires = appendRPMLib(requires, p, fileCount)

	writeRelations(h, provides, tagProvideName, tagProvideVersion, tagProvideFlags)
	writeRelations(h, requires, tagRequireName, tagRequireVersion, tagRequireFlags)
	writeRelations(h, p.conflicts.rels, tagConflictName, tagConflictVersion, tagConflictFlags)
	writeRelations(h, p.obsoletes.rels, tagObsoleteName, tagObsoleteVersion, tagObsoleteFlags)
	writeRelations(h, p.recommends.rels, tagRecommendName, tagRecommendVersion, tagRecommendFlags)
	writeRelations(h, p.suggests.rels, tagSuggestName, tagSuggestVersion, tagSuggestFlags)
	writeRelations(h, p.supplements.rels, tagSupplementName, tagSupplementVersion, tagSupplementFlags)
	writeRelations(h, p.enhances.rels, tagEnhanceName, tagEnhanceVersion, tagEnhanceFlags)
	writeRelations(h, p.order.rels, tagOrderName, tagOrderVersion, tagOrderFlags)
}

// appendRPMLib adds the standard rpmlib() feature requirements that describe the
// header/payload features this package relies on, so rpm can verify it supports
// them before installing.
func appendRPMLib(reqs []*relation, p *rpmPackage, fileCount int) []*relation {
	rpmlibSense := SenseRPMLIB | SenseLessEqual
	add := func(name, ver string) {
		r := &relation{name: name, version: ver, sense: rpmlibSense}
		for _, existing := range reqs {
			if existing.Equal(r) {
				return
			}
		}
		reqs = append(reqs, r)
	}
	if p.hasLuaScripts() {
		add("rpmlib(BuiltinLuaScripts)", "4.2.2-1")
	}
	// Gate on the number of file entries actually emitted (which excludes the
	// skipped root "/"), so these never claim file features a meta package lacks.
	if fileCount > 0 {
		add("rpmlib(CompressedFileNames)", "3.0.4-1")
		add("rpmlib(FileDigests)", "4.6.0-1")
		add("rpmlib(PayloadFilesHavePrefix)", "4.0-1")
	}
	switch p.compressor.name() {
	case "xz":
		add("rpmlib(PayloadIsXz)", "5.2-1")
	case "zstd":
		add("rpmlib(PayloadIsZstd)", "5.4.18-1")
	case "lzma":
		add("rpmlib(PayloadIsLzma)", "4.4.6-1")
	}
	return reqs
}

// hasLuaScripts follows the same emission rules as the script serializers.
func (p *rpmPackage) hasLuaScripts() bool {
	for _, data := range p.scriptlets {
		if data.script != "" && data.interpreter == "<lua>" {
			return true
		}
	}
	for _, tr := range p.triggers {
		if tr.emitted() && tr.interpreter == "<lua>" {
			return true
		}
	}
	return false
}

var scriptletTags = map[scriptletKind][2]int{
	scriptletPretrans:  {tagPretrans, tagPretransProg},
	scriptletPrein:     {tagPrein, tagPreinProg},
	scriptletPostin:    {tagPostin, tagPostinProg},
	scriptletPreun:     {tagPreun, tagPreunProg},
	scriptletPostun:    {tagPostun, tagPostunProg},
	scriptletPosttrans: {tagPosttrans, tagPosttransProg},
	scriptletVerify:    {tagVerifyScript, tagVerifyScriptProg},
}

func (p *rpmPackage) writeScriptlets(h *index) {
	for kind, data := range p.scriptlets {
		if data.script == "" {
			continue
		}
		tags := scriptletTags[kind]
		interp := data.interpreter
		if interp == "" {
			interp = "/bin/sh"
		}
		h.add(tags[0], EntryString(data.script))
		h.add(tags[1], EntryString(interp))
	}
}

func (p *rpmPackage) writeTriggers(h *index) {
	var names, versions, scripts, progs []string
	var flags, indexes []int32
	for _, tr := range p.triggers {
		if !tr.emitted() {
			continue
		}
		scriptIdx := int32(len(scripts))
		scripts = append(scripts, tr.script)
		interp := tr.interpreter
		if interp == "" {
			interp = "/bin/sh"
		}
		progs = append(progs, interp)
		for _, c := range tr.conds {
			names = append(names, c.name)
			versions = append(versions, c.version)
			flags = append(flags, int32(c.sense|tr.kind.senseBit()))
			indexes = append(indexes, scriptIdx)
		}
	}
	if len(names) == 0 {
		return
	}
	h.add(tagTriggerName, EntryStringSlice(names))
	h.add(tagTriggerVersion, EntryStringSlice(versions))
	h.add(tagTriggerFlags, EntryInt32(flags))
	h.add(tagTriggerIndex, EntryInt32(indexes))
	h.add(tagTriggerScripts, EntryStringSlice(scripts))
	h.add(tagTriggerScriptProg, EntryStringSlice(progs))
}

func (p *rpmPackage) writeChangelog(h *index) {
	if len(p.changelog) == 0 {
		return
	}
	entries := append([]changelogEntry(nil), p.changelog...)
	// rpm convention: newest entry first.
	sort.SliceStable(entries, func(i, j int) bool {
		return entries[i].when.After(entries[j].when)
	})
	times := make([]int32, len(entries))
	names := make([]string, len(entries))
	texts := make([]string, len(entries))
	for i, e := range entries {
		times[i] = int32(e.when.Unix())
		names[i] = e.author
		texts[i] = e.text
	}
	h.add(tagChangelogTime, EntryInt32(times))
	h.add(tagChangelogName, EntryStringSlice(names))
	h.add(tagChangelogText, EntryStringSlice(texts))
}

func (p *rpmPackage) writeSourceTags(h *index) {
	if len(p.sources) > 0 {
		h.add(tagSource, EntryStringSlice(p.sources))
	}
	if len(p.patches) > 0 {
		h.add(tagPatch, EntryStringSlice(p.patches))
	}
	if len(p.noSources) > 0 {
		h.add(tagNoSource, EntryInt32(p.noSources))
	}
	if len(p.noPatches) > 0 {
		h.add(tagNoPatch, EntryInt32(p.noPatches))
	}
}
