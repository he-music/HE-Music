package main

import (
	"regexp"
	"strings"
)

var identityLine = regexp.MustCompile(`^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"(.*)"`)

// developmentIdentity returns the hash and name of the identity that signs
// the development app when mygo dev has no -sign, from the output of
// security find-identity -v -p codesigning: an Apple Development identity,
// as Xcode signs Debug builds, or one of its old name, Mac Developer. When
// there are several, as for several teams, the one of team (that of
// macos.signingIdentity), else the first. Without one, it returns "".
//
// Its signature, unlike an ad hoc one, is the same from build to build: the
// designated requirement names the identifier and the certificate, not a
// hash of the code. macOS keeps what the user allowed the app, such as
// Accessibility or Screen Recording, and "Always Allow" for its Keychain
// items, by that requirement, so with ad hoc signing it takes every build
// for another app, asking again.
func developmentIdentity(out, team string) (hash, name string) {
	var first [2]string
	for _, prefix := range []string{"Apple Development: ", "Mac Developer: "} {
		for line := range strings.SplitSeq(out, "\n") {
			m := identityLine.FindStringSubmatch(line)
			if m == nil || !strings.HasPrefix(m[2], prefix) {
				continue
			}
			if team != "" && strings.HasSuffix(m[2], "("+team+")") {
				return m[1], m[2]
			}
			if first[0] == "" {
				first = [2]string{m[1], m[2]}
			}
		}
	}
	return first[0], first[1]
}

// signingTeam returns the team identifier at the end of an identity's
// name, as TEAMID of "Developer ID Application: Jane Doe (TEAMID)", or "".
func signingTeam(identity string) string {
	if !strings.HasSuffix(identity, ")") {
		return ""
	}
	i := strings.LastIndex(identity, "(")
	if i < 0 {
		return ""
	}
	return identity[i+1 : len(identity)-1]
}
