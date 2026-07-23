package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

type mediaMetadata struct {
	Width           int
	Height          int
	DurationSeconds float64
	Codecs          []string
	Properties      map[string]string
}

func newMediaMetadata() mediaMetadata {
	return mediaMetadata{Properties: make(map[string]string)}
}

func (m *mediaMetadata) set(label, value string) {
	value = strings.TrimSpace(value)
	if value != "" {
		m.Properties[label] = value
	}
}

func mergeMediaMetadata(target *mediaMetadata, source mediaMetadata) {
	if source.Width > 0 && source.Height > 0 {
		target.Width, target.Height = source.Width, source.Height
	}
	if source.DurationSeconds > 0 {
		target.DurationSeconds = source.DurationSeconds
	}
	seen := make(map[string]struct{}, len(target.Codecs)+len(source.Codecs))
	for _, codec := range append(append([]string(nil), target.Codecs...), source.Codecs...) {
		codec = strings.TrimSpace(codec)
		if codec == "" {
			continue
		}
		if _, exists := seen[codec]; exists {
			continue
		}
		seen[codec] = struct{}{}
		target.Codecs = append(target.Codecs, codec)
	}
	for key, value := range source.Properties {
		target.set(key, value)
	}
}

func parseBoundedFileMetadata(data []byte, extension, contentType string, objectSize int64) mediaMetadata {
	result := newMediaMetadata()
	if width, height, ok := parseImageDimensions(data, extension, contentType); ok {
		result.Width, result.Height = width, height
	}
	if exif := parseEXIFMetadata(data); exif != nil {
		mergeMediaMetadata(&result, *exif)
	}
	switch extension {
	case "mp3":
		mergeMediaMetadata(&result, parseMP3Metadata(data, objectSize))
	case "wav", "wave":
		mergeMediaMetadata(&result, parseWAVMetadata(data))
	case "flac":
		mergeMediaMetadata(&result, parseFLACMetadata(data))
	case "ogg", "oga", "opus", "ogv":
		if bytes.Contains(data, []byte("OpusHead")) {
			result.Codecs = append(result.Codecs, "opus")
		} else if bytes.Contains(data, []byte("vorbis")) {
			result.Codecs = append(result.Codecs, "vorbis")
		}
	}
	return result
}

func rafPreviewRange(data []byte) (int64, int64, bool) {
	if len(data) < 92 || !bytes.HasPrefix(data, []byte("FUJIFILMCCD-RAW ")) {
		return 0, 0, false
	}
	offset := int64(binary.BigEndian.Uint32(data[84:88]))
	length := int64(binary.BigEndian.Uint32(data[88:92]))
	if offset < 0 || length <= 0 || offset > 1<<50 || length > 1<<34 {
		return 0, 0, false
	}
	return offset, length, true
}

type tiffReader struct {
	data   []byte
	layout tiffLayout
}

type tiffLayout struct {
	order           binary.ByteOrder
	bigTIFF         bool
	firstIFD        uint64
	countSize       int
	entrySize       int
	inlineValueSize int64
	nextOffsetSize  int
}

// parseTIFFLayout recognizes classic TIFF, BigTIFF, and the TIFF-like headers
// used by common camera RAW containers such as Olympus ORF and Panasonic RW2.
// The metadata parser still follows only declared IFD offsets; it never scans
// image payloads looking for tags.
func parseTIFFLayout(data []byte) (tiffLayout, bool) {
	if len(data) < 8 {
		return tiffLayout{}, false
	}
	var order binary.ByteOrder
	switch string(data[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return tiffLayout{}, false
	}

	magic := order.Uint16(data[2:4])
	switch magic {
	case 42, 0x4f52, 0x5352, 0x0055:
		return tiffLayout{
			order:           order,
			firstIFD:        uint64(order.Uint32(data[4:8])),
			countSize:       2,
			entrySize:       12,
			inlineValueSize: 4,
			nextOffsetSize:  4,
		}, true
	case 43:
		if len(data) < 16 || order.Uint16(data[4:6]) != 8 || order.Uint16(data[6:8]) != 0 {
			return tiffLayout{}, false
		}
		return tiffLayout{
			order:           order,
			bigTIFF:         true,
			firstIFD:        order.Uint64(data[8:16]),
			countSize:       8,
			entrySize:       20,
			inlineValueSize: 8,
			nextOffsetSize:  8,
		}, true
	default:
		return tiffLayout{}, false
	}
}

func newTIFFReader(data []byte) (*tiffReader, uint64, bool) {
	layout, ok := parseTIFFLayout(data)
	if !ok || layout.firstIFD == 0 || layout.firstIFD >= uint64(len(data)) {
		return nil, 0, false
	}
	return &tiffReader{data: data, layout: layout}, layout.firstIFD, true
}

func jpegEXIFPayload(data []byte) []byte {
	if len(data) < 4 || data[0] != 0xff || data[1] != 0xd8 {
		return nil
	}
	for offset := 2; offset+4 <= len(data); {
		for offset < len(data) && data[offset] == 0xff {
			offset++
		}
		if offset >= len(data) {
			break
		}
		marker := data[offset]
		offset++
		if marker == 0xd8 || marker == 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker == 0x01 {
			continue
		}
		if offset+2 > len(data) {
			break
		}
		length := int(binary.BigEndian.Uint16(data[offset : offset+2]))
		if length < 2 || offset+length > len(data) {
			break
		}
		payload := data[offset+2 : offset+length]
		if marker == 0xe1 && len(payload) >= 6 && bytes.Equal(payload[:6], []byte{'E', 'x', 'i', 'f', 0, 0}) {
			return payload[6:]
		}
		offset += length
	}
	return nil
}

func parseEXIFMetadata(data []byte) *mediaMetadata {
	tiff := data
	if payload := jpegEXIFPayload(data); payload != nil {
		tiff = payload
	}
	reader, firstIFD, ok := newTIFFReader(tiff)
	if !ok {
		return nil
	}
	result := newMediaMetadata()
	baseTags := reader.readIFD(firstIFD)
	result.set("Camera make", reader.asString(baseTags[0x010f]))
	result.set("Camera model", reader.asString(baseTags[0x0110]))
	result.set("Software", reader.asString(baseTags[0x0131]))
	result.set("Captured", reader.asString(baseTags[0x0132]))
	if orientation := reader.asUint(baseTags[0x0112]); orientation > 0 {
		result.set("Orientation", orientationLabel(orientation))
	}
	if width := int(reader.asUint(baseTags[0x0100])); width > 0 {
		result.Width = width
	}
	if height := int(reader.asUint(baseTags[0x0101])); height > 0 {
		result.Height = height
	}

	if exifOffset := reader.asUint(baseTags[0x8769]); exifOffset > 0 {
		exifTags := reader.readIFD(exifOffset)
		if value := reader.asString(exifTags[0x9003]); value != "" {
			result.set("Captured", value)
		}
		result.set("Lens", reader.asString(exifTags[0xa434]))
		result.set("Lens make", reader.asString(exifTags[0xa433]))
		if iso := reader.asUint(exifTags[0x8827]); iso > 0 {
			result.set("ISO", strconv.FormatUint(iso, 10))
		}
		if value, ok := reader.asRational(exifTags[0x829a]); ok && value > 0 {
			result.set("Exposure", formatExposure(value))
		}
		if value, ok := reader.asRational(exifTags[0x829d]); ok && value > 0 {
			result.set("Aperture", fmt.Sprintf("f/%.1f", value))
		}
		if value, ok := reader.asRational(exifTags[0x920a]); ok && value > 0 {
			result.set("Focal length", fmt.Sprintf("%.1f mm", value))
		}
		if focal35 := reader.asUint(exifTags[0xa405]); focal35 > 0 {
			result.set("35 mm equivalent", fmt.Sprintf("%d mm", focal35))
		}
		if width := int(reader.asUint(exifTags[0xa002])); width > 0 {
			result.Width = width
		}
		if height := int(reader.asUint(exifTags[0xa003])); height > 0 {
			result.Height = height
		}
	}

	if gpsOffset := reader.asUint(baseTags[0x8825]); gpsOffset > 0 {
		gps := reader.readIFD(gpsOffset)
		lat, latOK := reader.asDMS(gps[0x0002])
		lon, lonOK := reader.asDMS(gps[0x0004])
		if strings.EqualFold(reader.asString(gps[0x0001]), "S") {
			lat = -lat
		}
		if strings.EqualFold(reader.asString(gps[0x0003]), "W") {
			lon = -lon
		}
		if latOK && lonOK && math.Abs(lat) <= 90 && math.Abs(lon) <= 180 {
			result.set("GPS", fmt.Sprintf("%.6f, %.6f", lat, lon))
		}
		if altitude, ok := reader.asRational(gps[0x0006]); ok {
			if reader.asUint(gps[0x0005]) == 1 {
				altitude = -altitude
			}
			result.set("GPS altitude", fmt.Sprintf("%.1f m", altitude))
		}
	}
	return &result
}

type tiffEntry struct {
	typeID uint16
	count  uint64
	value  [8]byte
}

func (r *tiffReader) readIFD(offset uint64) map[uint16]tiffEntry {
	out := make(map[uint16]tiffEntry)
	if r == nil || offset > uint64(len(r.data)) || uint64(r.layout.countSize) > uint64(len(r.data))-offset {
		return out
	}
	cursor := int(offset)
	var count uint64
	if r.layout.bigTIFF {
		count = r.layout.order.Uint64(r.data[cursor : cursor+8])
	} else {
		count = uint64(r.layout.order.Uint16(r.data[cursor : cursor+2]))
	}
	if count > 4096 {
		count = 4096
	}
	cursor += r.layout.countSize
	for index := uint64(0); index < count && cursor+r.layout.entrySize <= len(r.data); index++ {
		entryData := r.data[cursor : cursor+r.layout.entrySize]
		entry := tiffEntry{
			typeID: r.layout.order.Uint16(entryData[2:4]),
		}
		if r.layout.bigTIFF {
			entry.count = r.layout.order.Uint64(entryData[4:12])
			copy(entry.value[:], entryData[12:20])
		} else {
			entry.count = uint64(r.layout.order.Uint32(entryData[4:8]))
			copy(entry.value[:4], entryData[8:12])
		}
		out[r.layout.order.Uint16(entryData[:2])] = entry
		cursor += r.layout.entrySize
	}
	return out
}

func tiffTypeSize(typeID uint16) int64 {
	switch typeID {
	case 1, 2, 6, 7:
		return 1
	case 3, 8:
		return 2
	case 4, 9, 11:
		return 4
	case 5, 10, 12:
		return 8
	default:
		return 0
	}
}

func (r *tiffReader) entryBytes(entry tiffEntry) []byte {
	if entry.count > uint64(math.MaxInt64) {
		return nil
	}
	size := tiffTypeSize(entry.typeID) * int64(entry.count)
	if size <= 0 || size > int64(len(r.data)) || size > 1<<20 {
		return nil
	}
	if size <= r.layout.inlineValueSize {
		return entry.value[:size]
	}
	var offset uint64
	if r.layout.bigTIFF {
		offset = r.layout.order.Uint64(entry.value[:])
	} else {
		offset = uint64(r.layout.order.Uint32(entry.value[:4]))
	}
	if offset > uint64(math.MaxInt64) {
		return nil
	}
	offset64 := int64(offset)
	if offset64 < 0 || offset64+size > int64(len(r.data)) {
		return nil
	}
	return r.data[offset64 : offset64+size]
}

func (r *tiffReader) asString(entry tiffEntry) string {
	data := r.entryBytes(entry)
	if len(data) == 0 {
		return ""
	}
	data = bytes.Trim(data, "\x00 \t\r\n")
	if !utf8.Valid(data) {
		runes := make([]rune, 0, len(data))
		for _, value := range data {
			runes = append(runes, rune(value))
		}
		return strings.TrimSpace(string(runes))
	}
	return strings.TrimSpace(string(data))
}

func (r *tiffReader) asUint(entry tiffEntry) uint64 {
	data := r.entryBytes(entry)
	if len(data) == 0 {
		return 0
	}
	switch entry.typeID {
	case 1, 6, 7:
		return uint64(data[0])
	case 3, 8:
		if len(data) >= 2 {
			return uint64(r.layout.order.Uint16(data[:2]))
		}
	case 4, 9:
		if len(data) >= 4 {
			return uint64(r.layout.order.Uint32(data[:4]))
		}
	}
	return 0
}

func (r *tiffReader) asRational(entry tiffEntry) (float64, bool) {
	data := r.entryBytes(entry)
	if len(data) < 8 {
		return 0, false
	}
	if entry.typeID == 10 {
		numerator := int32(r.layout.order.Uint32(data[:4]))
		denominator := int32(r.layout.order.Uint32(data[4:8]))
		if denominator == 0 {
			return 0, false
		}
		return float64(numerator) / float64(denominator), true
	}
	numerator := r.layout.order.Uint32(data[:4])
	denominator := r.layout.order.Uint32(data[4:8])
	if denominator == 0 {
		return 0, false
	}
	return float64(numerator) / float64(denominator), true
}

func (r *tiffReader) asDMS(entry tiffEntry) (float64, bool) {
	data := r.entryBytes(entry)
	if len(data) < 24 || (entry.typeID != 5 && entry.typeID != 10) {
		return 0, false
	}
	values := make([]float64, 3)
	for index := range values {
		chunk := data[index*8 : index*8+8]
		numerator := r.layout.order.Uint32(chunk[:4])
		denominator := r.layout.order.Uint32(chunk[4:8])
		if denominator == 0 {
			return 0, false
		}
		values[index] = float64(numerator) / float64(denominator)
	}
	return values[0] + values[1]/60 + values[2]/3600, true
}

func orientationLabel(value uint64) string {
	labels := map[uint64]string{
		1: "Normal", 2: "Mirrored horizontally", 3: "Rotated 180°", 4: "Mirrored vertically",
		5: "Mirrored and rotated 90°", 6: "Rotated 90° clockwise", 7: "Mirrored and rotated 270°", 8: "Rotated 90° counter-clockwise",
	}
	if label := labels[value]; label != "" {
		return label
	}
	return strconv.FormatUint(value, 10)
}

func formatExposure(value float64) string {
	if value > 0 && value < 1 {
		denominator := math.Round(1 / value)
		if denominator > 0 {
			return fmt.Sprintf("1/%.0f s", denominator)
		}
	}
	return fmt.Sprintf("%.3g s", value)
}

func parseMP3Metadata(data []byte, objectSize int64) mediaMetadata {
	result := newMediaMetadata()
	result.Codecs = []string{"mp3"}
	cursor := 0
	if len(data) >= 10 && string(data[:3]) == "ID3" {
		version := data[3]
		tagSize := synchsafeUint32(data[6:10])
		end := mediaMinInt(len(data), 10+int(tagSize))
		cursor = 10
		for cursor+10 <= end {
			frameID := string(data[cursor : cursor+4])
			if strings.Trim(frameID, "\x00") == "" {
				break
			}
			frameSize := int(binary.BigEndian.Uint32(data[cursor+4 : cursor+8]))
			if version >= 4 {
				frameSize = int(synchsafeUint32(data[cursor+4 : cursor+8]))
			}
			cursor += 10
			if frameSize <= 0 || cursor+frameSize > end {
				break
			}
			value := decodeID3Text(data[cursor : cursor+frameSize])
			labels := map[string]string{"TIT2": "Title", "TPE1": "Artist", "TALB": "Album", "TDRC": "Year", "TYER": "Year", "TRCK": "Track", "TCON": "Genre", "TCOM": "Composer"}
			if label := labels[frameID]; label != "" {
				result.set(label, value)
			}
			cursor += frameSize
		}
		cursor = mediaMinInt(len(data), 10+int(tagSize))
	}
	frameOffset, bitrate, sampleRate, channels := findMP3Frame(data, cursor)
	_ = frameOffset
	if bitrate > 0 {
		result.set("Bit rate", fmt.Sprintf("%d kb/s", bitrate/1000))
		if objectSize > 0 {
			result.DurationSeconds = float64(objectSize*8) / float64(bitrate)
		}
	}
	if sampleRate > 0 {
		result.set("Sample rate", fmt.Sprintf("%s kHz", trimFloat(float64(sampleRate)/1000, 1)))
	}
	if channels > 0 {
		result.set("Channels", strconv.Itoa(channels))
	}
	return result
}

func synchsafeUint32(data []byte) uint32 {
	if len(data) < 4 {
		return 0
	}
	return uint32(data[0]&0x7f)<<21 | uint32(data[1]&0x7f)<<14 | uint32(data[2]&0x7f)<<7 | uint32(data[3]&0x7f)
}

func decodeID3Text(data []byte) string {
	if len(data) < 2 {
		return ""
	}
	encoding := data[0]
	payload := bytes.Trim(data[1:], "\x00")
	switch encoding {
	case 0:
		runes := make([]rune, 0, len(payload))
		for _, value := range payload {
			runes = append(runes, rune(value))
		}
		return strings.TrimSpace(string(runes))
	case 1, 2:
		bigEndian := encoding == 2
		if len(payload) >= 2 {
			if payload[0] == 0xff && payload[1] == 0xfe {
				bigEndian = false
				payload = payload[2:]
			} else if payload[0] == 0xfe && payload[1] == 0xff {
				bigEndian = true
				payload = payload[2:]
			}
		}
		values := make([]uint16, 0, len(payload)/2)
		for index := 0; index+1 < len(payload); index += 2 {
			if bigEndian {
				values = append(values, binary.BigEndian.Uint16(payload[index:index+2]))
			} else {
				values = append(values, binary.LittleEndian.Uint16(payload[index:index+2]))
			}
		}
		return strings.Trim(strings.TrimSpace(string(utf16.Decode(values))), "\x00")
	default:
		return strings.TrimSpace(string(payload))
	}
}

func findMP3Frame(data []byte, start int) (int, int, int, int) {
	bitrateTable := []int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0}
	sampleRates := []int{44100, 48000, 32000, 0}
	for offset := mediaMaxInt(0, start); offset+4 <= len(data); offset++ {
		header := binary.BigEndian.Uint32(data[offset : offset+4])
		if header&0xffe00000 != 0xffe00000 {
			continue
		}
		versionID := (header >> 19) & 0x3
		layer := (header >> 17) & 0x3
		bitrateIndex := int((header >> 12) & 0xf)
		sampleIndex := int((header >> 10) & 0x3)
		if versionID == 1 || layer != 1 || bitrateIndex == 0 || bitrateIndex == 15 || sampleIndex == 3 {
			continue
		}
		bitrate := bitrateTable[bitrateIndex] * 1000
		if versionID != 3 {
			bitrate /= 2
		}
		sampleRate := sampleRates[sampleIndex]
		if versionID == 2 {
			sampleRate /= 2
		} else if versionID == 0 {
			sampleRate /= 4
		}
		channelMode := (header >> 6) & 0x3
		channels := 2
		if channelMode == 3 {
			channels = 1
		}
		return offset, bitrate, sampleRate, channels
	}
	return 0, 0, 0, 0
}

func parseWAVMetadata(data []byte) mediaMetadata {
	result := newMediaMetadata()
	if len(data) < 12 || !bytes.Equal(data[:4], []byte("RIFF")) || !bytes.Equal(data[8:12], []byte("WAVE")) {
		return result
	}
	result.Codecs = []string{"pcm"}
	var byteRate uint32
	var dataSize uint32
	for offset := 12; offset+8 <= len(data); {
		id := string(data[offset : offset+4])
		size := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		start := offset + 8
		end := start + size
		if size < 0 || end > len(data) {
			break
		}
		chunk := data[start:end]
		switch id {
		case "fmt ":
			if len(chunk) >= 16 {
				format := binary.LittleEndian.Uint16(chunk[0:2])
				channels := binary.LittleEndian.Uint16(chunk[2:4])
				sampleRate := binary.LittleEndian.Uint32(chunk[4:8])
				byteRate = binary.LittleEndian.Uint32(chunk[8:12])
				bits := binary.LittleEndian.Uint16(chunk[14:16])
				codec := map[uint16]string{1: "PCM", 3: "IEEE float", 6: "A-law", 7: "µ-law"}[format]
				if codec != "" {
					result.Codecs = []string{strings.ToLower(codec)}
				}
				result.set("Channels", strconv.Itoa(int(channels)))
				result.set("Sample rate", fmt.Sprintf("%s kHz", trimFloat(float64(sampleRate)/1000, 1)))
				result.set("Bit depth", fmt.Sprintf("%d-bit", bits))
			}
		case "data":
			dataSize = uint32(size)
		case "LIST":
			if len(chunk) > 4 && string(chunk[:4]) == "INFO" {
				parseWAVInfo(chunk[4:], &result)
			}
		}
		offset = end + size%2
	}
	if byteRate > 0 && dataSize > 0 {
		result.DurationSeconds = float64(dataSize) / float64(byteRate)
	}
	return result
}

func parseWAVInfo(data []byte, result *mediaMetadata) {
	labels := map[string]string{"INAM": "Title", "IART": "Artist", "IPRD": "Album", "ICRD": "Year", "IGNR": "Genre", "ICMT": "Comment"}
	for offset := 0; offset+8 <= len(data); {
		id := string(data[offset : offset+4])
		size := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		start, end := offset+8, offset+8+size
		if size < 0 || end > len(data) {
			break
		}
		if label := labels[id]; label != "" {
			result.set(label, strings.Trim(string(data[start:end]), "\x00 \r\n\t"))
		}
		offset = end + size%2
	}
}

func parseFLACMetadata(data []byte) mediaMetadata {
	result := newMediaMetadata()
	if len(data) < 8 || !bytes.Equal(data[:4], []byte("fLaC")) {
		return result
	}
	result.Codecs = []string{"flac"}
	for offset := 4; offset+4 <= len(data); {
		header := data[offset]
		blockType := header & 0x7f
		length := int(data[offset+1])<<16 | int(data[offset+2])<<8 | int(data[offset+3])
		start, end := offset+4, offset+4+length
		if length < 0 || end > len(data) {
			break
		}
		block := data[start:end]
		if blockType == 0 && len(block) >= 34 {
			packed := binary.BigEndian.Uint64(block[10:18])
			sampleRate := int((packed >> 44) & 0xfffff)
			channels := int((packed>>41)&0x7) + 1
			bits := int((packed>>36)&0x1f) + 1
			totalSamples := packed & 0xfffffffff
			if sampleRate > 0 {
				result.DurationSeconds = float64(totalSamples) / float64(sampleRate)
				result.set("Sample rate", fmt.Sprintf("%s kHz", trimFloat(float64(sampleRate)/1000, 1)))
			}
			result.set("Channels", strconv.Itoa(channels))
			result.set("Bit depth", fmt.Sprintf("%d-bit", bits))
		} else if blockType == 4 {
			parseVorbisComments(block, &result)
		}
		offset = end
		if header&0x80 != 0 {
			break
		}
	}
	return result
}

func parseVorbisComments(data []byte, result *mediaMetadata) {
	if len(data) < 8 {
		return
	}
	vendorLength := int(binary.LittleEndian.Uint32(data[:4]))
	cursor := 4 + vendorLength
	if cursor+4 > len(data) {
		return
	}
	count := int(binary.LittleEndian.Uint32(data[cursor : cursor+4]))
	cursor += 4
	labels := map[string]string{"TITLE": "Title", "ARTIST": "Artist", "ALBUM": "Album", "DATE": "Year", "TRACKNUMBER": "Track", "GENRE": "Genre", "COMMENT": "Comment"}
	for index := 0; index < count && cursor+4 <= len(data) && index < 256; index++ {
		length := int(binary.LittleEndian.Uint32(data[cursor : cursor+4]))
		cursor += 4
		if length < 0 || cursor+length > len(data) {
			break
		}
		entry := string(data[cursor : cursor+length])
		cursor += length
		key, value, found := strings.Cut(entry, "=")
		if found {
			result.set(labels[strings.ToUpper(key)], value)
		}
	}
}

func trimFloat(value float64, decimals int) string {
	return strconv.FormatFloat(value, 'f', decimals, 64)
}

func mediaMinInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func mediaMaxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
