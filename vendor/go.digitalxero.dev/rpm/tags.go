package rpm

// tags.go enumerates the RPM header/signature tag numbers and the on-disk entry
// type codes used by the index encoder. Values are verified against rpm's
// include/rpm/rpmtag.h and include/rpm/rpmds.h. They are deliberately kept
// unexported: callers never reference raw tag numbers, they use the typed
// builder API. The escape hatch AddCustomTag/AddCustomSig accepts arbitrary
// integer tags for power users. Only tags this package actually emits are
// defined here.

// RPM index entry type codes (rpmTagType_e).
const (
	typeChar        = 1 // 1 byte, alignment 1
	typeInt8        = 2 // 1 byte, alignment 1
	typeInt16       = 3 // 2 bytes, alignment 2
	typeInt32       = 4 // 4 bytes, alignment 4
	typeInt64       = 5 // 8 bytes, alignment 8
	typeString      = 6 // NUL-terminated, no alignment
	typeBin         = 7 // raw bytes, no alignment
	typeStringArray = 8 // NUL-terminated array, no alignment
	typeI18NString  = 9 // NUL-terminated (one per locale), no alignment
)

// Header regions. The first index entry of every header is a "region" / immutable
// trailer pointing at itself with a negative offset.
const (
	regionSignatures = 0x3e // 62, RPMTAG_HEADERSIGNATURES
	regionImmutable  = 0x3f // 63, RPMTAG_HEADERIMMUTABLE
)

// Header magic: 0x8e 0xad 0xe8 + version byte 0x01, followed by 4 reserved zero
// bytes.
var headerMagic = []byte{0x8e, 0xad, 0xe8, 0x01, 0, 0, 0, 0}

// PGP/digest hash algorithm identifiers (rpmpgp.h, PGPHASHALGO).
const (
	hashAlgoMD5    = 1
	hashAlgoSHA1   = 2
	hashAlgoSHA256 = 8
	hashAlgoSHA384 = 9
	hashAlgoSHA512 = 10
)

// Signature header tags (rpmSigTag). Note the crypto/long-size tags reuse the
// RPMTAG_SIG_BASE (256) numbering, while the size/payload tags use the 1000
// range. rpmpack's "sigRSA // 256" comment is wrong: 0x010c == 268.
const (
	sigSize            = 1000 // INT32: header + payload byte count
	sigPGP             = 1002 // BIN: OpenPGP signature over header+payload (RSA)
	sigMD5             = 1004 // BIN: md5 over header+payload
	sigGPG             = 1005 // BIN: OpenPGP signature over header+payload (DSA)
	sigPayloadSize     = 1007 // INT32: uncompressed payload size
	sigReservedSpace   = 1008 // BIN: zero padding reserved for `rpm --addsign`
	sigDSA             = 267  // BIN: OpenPGP signature over header only (DSA)
	sigRSA             = 268  // BIN: OpenPGP signature over header only (RSA)
	sigSHA1            = 269  // STRING: hex sha1 of header
	sigLongSize        = 270  // INT64: 64-bit form of sigSize
	sigLongArchiveSize = 271  // INT64: 64-bit form of sigPayloadSize
	sigSHA256          = 273  // STRING: hex sha256 of header
)

// Main header tags (rpmTag).
const (
	tagHeaderI18NTable = 100 // 0x64

	tagName         = 1000
	tagVersion      = 1001
	tagRelease      = 1002
	tagEpoch        = 1003
	tagSummary      = 1004
	tagDescription  = 1005
	tagBuildTime    = 1006
	tagBuildHost    = 1007
	tagSize         = 1009
	tagDistribution = 1010
	tagVendor       = 1011
	tagLicense      = 1014
	tagPackager     = 1015
	tagGroup        = 1016
	tagSource       = 1018 // STRING_ARRAY: source file basenames (SRPM)
	tagPatch        = 1019 // STRING_ARRAY: patch file basenames (SRPM)
	tagURL          = 1020
	tagOS           = 1021
	tagArch         = 1022

	tagPrein  = 1023
	tagPostin = 1024
	tagPreun  = 1025
	tagPostun = 1026

	tagFileSizes       = 1028
	tagFileModes       = 1030
	tagFileRDevs       = 1033
	tagFileMTimes      = 1034
	tagFileDigests     = 1035
	tagFileLinkTos     = 1036
	tagFileFlags       = 1037
	tagFileUserName    = 1039
	tagFileGroupName   = 1040
	tagSourceRPM       = 1044
	tagFileVerifyFlags = 1045

	tagProvideName     = 1047
	tagRequireFlags    = 1048
	tagRequireName     = 1049
	tagRequireVersion  = 1050
	tagNoSource        = 1051 // INT32[]: excluded source indexes (SRPM)
	tagNoPatch         = 1052 // INT32[]: excluded patch indexes (SRPM)
	tagConflictFlags   = 1053
	tagConflictName    = 1054
	tagConflictVersion = 1055

	tagExcludeArch   = 1059 // STRING_ARRAY: arches the package excludes
	tagExcludeOS     = 1060 // STRING_ARRAY: OSes the package excludes
	tagExclusiveArch = 1061 // STRING_ARRAY: the only arches the package allows
	tagExclusiveOS   = 1062 // STRING_ARRAY: the only OSes the package allows
	tagRPMVersion    = 1064 // STRING: producer identity

	tagTriggerScripts = 1065
	tagTriggerName    = 1066
	tagTriggerVersion = 1067
	tagTriggerFlags   = 1068
	tagTriggerIndex   = 1069

	tagChangelogTime = 1080
	tagChangelogName = 1081
	tagChangelogText = 1082

	tagVerifyScript      = 1079
	tagPreinProg         = 1085
	tagPostinProg        = 1086
	tagPreunProg         = 1087
	tagPostunProg        = 1088
	tagBuildArchs        = 1089 // STRING_ARRAY: BuildArch values (e.g. noarch)
	tagObsoleteName      = 1090
	tagVerifyScriptProg  = 1091
	tagTriggerScriptProg = 1092

	tagFileDevices = 1095
	tagFileINodes  = 1096
	tagFileLangs   = 1097
	tagPrefixes    = 1098

	tagSourcePackage = 1106 // INT32: 1 marks a source package

	tagProvideFlags    = 1112
	tagProvideVersion  = 1113
	tagObsoleteFlags   = 1114
	tagObsoleteVersion = 1115
	tagDirIndexes      = 1116
	tagBasenames       = 1117
	tagDirNames        = 1118

	tagOptFlags          = 1122 // STRING: compiler flags used to build
	tagPayloadFormat     = 1124
	tagPayloadCompressor = 1125
	tagPayloadFlags      = 1126
	tagPlatform          = 1132 // STRING: build platform triple

	tagFileColors   = 1140
	tagFileClass    = 1141 // INT32[]: per-file index into CLASSDICT
	tagClassDict    = 1142 // STRING_ARRAY: deduplicated file class strings
	tagFileDependsX = 1143 // INT32[]: per-file start offset into DEPENDSDICT
	tagFileDependsN = 1144 // INT32[]: per-file dependency count
	tagDependsDict  = 1145 // INT32[]: (deptype<<24)|index dependency references
	tagSourcePkgID  = 1146

	tagPretrans      = 1151
	tagPosttrans     = 1152
	tagPretransProg  = 1153
	tagPosttransProg = 1154

	tagVCS = 5034 // STRING: version-control URL

	tagLongFileSizes  = 5008 // INT64[]
	tagLongSize       = 5009 // INT64
	tagFileCaps       = 5010 // STRING_ARRAY
	tagFileDigestAlgo = 5011 // INT32 (scalar)

	tagOrderName    = 5035
	tagOrderVersion = 5036
	tagOrderFlags   = 5037

	tagRecommendName     = 5046
	tagRecommendVersion  = 5047
	tagRecommendFlags    = 5048
	tagSuggestName       = 5049
	tagSuggestVersion    = 5050
	tagSuggestFlags      = 5051
	tagSupplementName    = 5052
	tagSupplementVersion = 5053
	tagSupplementFlags   = 5054
	tagEnhanceName       = 5055
	tagEnhanceVersion    = 5056
	tagEnhanceFlags      = 5057

	tagPayloadDigest     = 5092
	tagPayloadDigestAlgo = 5093
)

// RPMSENSE_* dependency/comparison flag bits (rpmds.h). The comparison bits are
// exposed publicly via the Sense type in relation.go; the trigger/rpmlib bits are
// used internally. (rpm defines further bits — PREREQ, INTERP, the SCRIPT_*
// senses, etc. — which this package does not currently emit.)
const (
	senseAny     = 0
	senseLess    = 1 << 1 // 2
	senseGreater = 1 << 2 // 4
	senseEqual   = 1 << 3 // 8

	sensePostTrans    = 1 << 5  // 32:  Requires(posttrans)
	sensePreReq       = 1 << 6  // 64:  legacy PreReq
	sensePreTrans     = 1 << 7  // 128: Requires(pretrans)
	senseInterp       = 1 << 8  // 256: interpreter dependency
	senseScriptPre    = 1 << 9  // 512:  Requires(pre)
	senseScriptPost   = 1 << 10 // 1024: Requires(post)
	senseScriptPreUn  = 1 << 11 // 2048: Requires(preun)
	senseScriptPostUn = 1 << 12 // 4096: Requires(postun)
	senseScriptVerify = 1 << 13 // 8192: Requires(verify)

	senseTriggerIn     = 1 << 16 // 65536
	senseTriggerUn     = 1 << 17 // 131072
	senseTriggerPostUn = 1 << 18 // 262144
	senseMissingOK     = 1 << 19 // 524288: weak/optional dependency

	senseRPMLIB       = 1 << 24 // 16777216
	senseTriggerPreIn = 1 << 25 // 33554432
	senseConfig       = 1 << 28 // config() dependency
)

// fileFlagSpecFile is the RPMFILE_SPECFILE bit (rpmfiles.h). The other RPMFILE_*
// bits are the values of the public FileType constants in file.go; this one is
// applied internally to the spec file of a source package.
const fileFlagSpecFile = 1 << 5 // 32
