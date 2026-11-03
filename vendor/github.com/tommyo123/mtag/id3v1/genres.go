package id3v1

import "strings"

// Genres is the canonical ID3v1 genre table. Indices 0–79 are the
// original list defined by Eric Kemp, 80–147 are the Winamp
// extensions, and 148–191 were added in later Winamp releases. The
// value 255 ($FF) signals "no genre" and is written as such.
var Genres = [...]string{
	"Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk",
	"Grunge", "Hip-Hop", "Jazz", "Metal", "New Age", "Oldies",
	"Other", "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno",
	"Industrial", "Alternative", "Ska", "Death Metal", "Pranks",
	"Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal",
	"Jazz+Funk", "Fusion", "Trance", "Classical", "Instrumental",
	"Acid", "House", "Game", "Sound Clip", "Gospel", "Noise",
	"AlternRock", "Bass", "Soul", "Punk", "Space", "Meditative",
	"Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic",
	"Darkwave", "Techno-Industrial", "Electronic", "Pop-Folk",
	"Eurodance", "Dream", "Southern Rock", "Comedy", "Cult",
	"Gangsta", "Top 40", "Christian Rap", "Pop/Funk", "Jungle",
	"Native American", "Cabaret", "New Wave", "Psychadelic", "Rave",
	"Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk",
	"Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll",
	"Hard Rock",
	// Winamp extensions begin at 80
	"Folk", "Folk-Rock", "National Folk", "Swing", "Fast Fusion",
	"Bebob", "Latin", "Revival", "Celtic", "Bluegrass", "Avantgarde",
	"Gothic Rock", "Progressive Rock", "Psychedelic Rock",
	"Symphonic Rock", "Slow Rock", "Big Band", "Chorus",
	"Easy Listening", "Acoustic", "Humour", "Speech", "Chanson",
	"Opera", "Chamber Music", "Sonata", "Symphony", "Booty Bass",
	"Primus", "Porn Groove", "Satire", "Slow Jam", "Club", "Tango",
	"Samba", "Folklore", "Ballad", "Power Ballad", "Rhythmic Soul",
	"Freestyle", "Duet", "Punk Rock", "Drum Solo", "A Cappella",
	"Euro-House", "Dance Hall", "Goa", "Drum & Bass", "Club-House",
	"Hardcore", "Terror", "Indie", "BritPop", "Negerpunk",
	"Polsk Punk", "Beat", "Christian Gangsta Rap", "Heavy Metal",
	"Black Metal", "Crossover", "Contemporary Christian",
	"Christian Rock", "Merengue", "Salsa", "Thrash Metal", "Anime",
	"Jpop", "Synthpop",
	// Winamp 5.6 additions (148+)
	"Abstract", "Art Rock", "Baroque", "Bhangra", "Big Beat",
	"Breakbeat", "Chillout", "Downtempo", "Dub", "EBM", "Eclectic",
	"Electro", "Electroclash", "Emo", "Experimental", "Garage",
	"Global", "IDM", "Illbient", "Industro-Goth", "Jam Band",
	"Krautrock", "Leftfield", "Lounge", "Math Rock", "New Romantic",
	"Nu-Breakz", "Post-Punk", "Post-Rock", "Psytrance", "Shoegaze",
	"Space Rock", "Trop Rock", "World Music", "Neoclassical",
	"Audiobook", "Audio Theatre", "Neue Deutsche Welle", "Podcast",
	"Indie Rock", "G-Funk", "Dubstep", "Garage Rock", "Psybient",
}

// GenreName returns the human-readable name for id. An empty string
// is returned for 255 ("no genre") or any unknown id.
func GenreName(id byte) string {
	if int(id) < len(Genres) {
		return Genres[id]
	}
	return ""
}

// GenreID returns the id whose name case-insensitively matches name,
// or 255 if no match is found.
func GenreID(name string) byte {
	name = strings.TrimSpace(name)
	for i, g := range Genres {
		if strings.EqualFold(g, name) {
			return byte(i)
		}
	}
	return 255
}
