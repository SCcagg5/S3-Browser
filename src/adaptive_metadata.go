package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
)

const (
	// This is a corruption/abuse guard, not a target read size. Parsers stop at
	// each format's declared end-of-metadata marker and normally read far less.
	maxMetadataStructureBytes = int64(128 << 20)
	metadataGrowthFloor       = int64(64 << 10)
)

type mediaTrackInfo struct {
	Index         int    `json:"index"`
	Type          string `json:"type"`
	Codec         string `json:"codec,omitempty"`
	CodecLongName string `json:"codecLongName,omitempty"`
	Profile       string `json:"profile,omitempty"`
	PixelFormat   string `json:"pixelFormat,omitempty"`
	Language      string `json:"language,omitempty"`
	Title         string `json:"title,omitempty"`
	Label         string `json:"label,omitempty"`
	Width         int    `json:"width,omitempty"`
	Height        int    `json:"height,omitempty"`
	Channels      int    `json:"channels,omitempty"`
	ChannelLayout string `json:"channelLayout,omitempty"`
	SampleRate    int    `json:"sampleRate,omitempty"`
	BitRate       int64  `json:"bitRate,omitempty"`
	FrameRate     string `json:"frameRate,omitempty"`
	Default       bool   `json:"default,omitempty"`
	Forced        bool   `json:"forced,omitempty"`
	SubtitleMode  string `json:"subtitleMode,omitempty"`
}

type adaptiveMediaMetadata struct {
	mediaMetadata
	Tracks []mediaTrackInfo
}

func metadataRangeLength(source *objectRangeSource, start, desired int64) int64 {
	if desired <= 0 {
		return 0
	}
	if source.Size() <= 0 {
		return desired
	}
	if start >= source.Size() {
		return 0
	}
	return minInt64(desired, source.Size()-start)
}

func metadataStructureLimit(source *objectRangeSource) int64 {
	if source.Size() > 0 {
		return minInt64(source.Size(), maxMetadataStructureBytes)
	}
	return maxMetadataStructureBytes
}

func inspectAdaptiveMetadata(source *objectRangeSource, extension, contentType string) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	extension = strings.ToLower(strings.TrimSpace(extension))
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))

	switch {
	case extension == "jpg" || extension == "jpeg" || contentType == "image/jpeg":
		metadata, err := readJPEGMetadataAt(source, 0, source.Size())
		mergeMediaMetadata(&result.mediaMetadata, metadata)
		return result, err
	case extension == "png" || contentType == "image/png":
		return inspectPNGMetadata(source)
	case extension == "gif" || contentType == "image/gif":
		return inspectFixedHeaderImage(source, extension, contentType, 16)
	case extension == "webp" || contentType == "image/webp":
		return inspectWebPMetadata(source)
	case extension == "bmp" || extension == "dib" || contentType == "image/bmp":
		return inspectFixedHeaderImage(source, extension, contentType, 64)
	case extension == "psd" || extension == "psb":
		return inspectFixedHeaderImage(source, extension, contentType, 32)
	case extension == "tga" || extension == "ico" || extension == "cur":
		return inspectFixedHeaderImage(source, extension, contentType, 64)
	case extension == "dds":
		return inspectFixedHeaderImage(source, extension, contentType, 128)
	case extension == "pcx":
		return inspectFixedHeaderImage(source, extension, contentType, 128)
	case extension == "sgi" || extension == "rgb" || extension == "rgba" || extension == "bw":
		return inspectFixedHeaderImage(source, extension, contentType, 512)
	case extension == "qoi" || contentType == "image/qoi":
		return inspectFixedHeaderImage(source, extension, contentType, 14)
	case extension == "ff" || extension == "farbfeld" || contentType == "image/farbfeld":
		return inspectFixedHeaderImage(source, extension, contentType, 16)
	case extension == "fits" || extension == "fit" || extension == "fts" || contentType == "image/fits" || contentType == "application/fits":
		return inspectFITSMetadata(source)
	case extension == "pnm" || extension == "ppm" || extension == "pgm" || extension == "pbm" || extension == "pam":
		return inspectPNMMetadata(source)
	case extension == "hdr" || extension == "rgbe":
		return inspectRadianceHDRMetadata(source)
	case extension == "exr":
		return inspectEXRMetadata(source)
	case extension == "jp2" || extension == "j2k" || extension == "jpf" || extension == "jpx" || extension == "jpc":
		return inspectJPEG2000Metadata(source)
	case extension == "svg" || contentType == "image/svg+xml":
		return inspectSVGMetadata(source)
	case extension == "raf":
		return inspectRAFMetadata(source)
	case isTIFFBasedImage(extension, contentType):
		return inspectTIFFMetadata(source)
	case isISOBaseMedia(extension, contentType) || isHEIFImage(extension, contentType):
		return inspectISOMetadata(source)
	case extension == "mkv" || extension == "webm" || strings.Contains(contentType, "matroska") || contentType == "video/webm":
		return inspectMatroskaMetadata(source)
	case extension == "mp3" || contentType == "audio/mpeg":
		return inspectMP3Metadata(source)
	case extension == "flac" || contentType == "audio/flac":
		return inspectFLACMetadata(source)
	case extension == "wav" || extension == "wave" || contentType == "audio/wav" || contentType == "audio/x-wav":
		return inspectWAVMetadata(source)
	case extension == "ogg" || extension == "oga" || extension == "opus" || extension == "ogv" || strings.Contains(contentType, "ogg"):
		return inspectOggMetadata(source)
	default:
		prefix, err := source.ReadPrefix(metadataRangeLength(source, 0, metadataGrowthFloor))
		if err != nil && err != io.EOF {
			return result, err
		}
		mergeMediaMetadata(&result.mediaMetadata, parseBoundedFileMetadata(prefix, extension, contentType, source.Size()))
		if width, height, ok := parseAdditionalImageDimensions(prefix, extension, contentType); ok {
			result.Width, result.Height = width, height
		}
		return result, nil
	}
}

func inspectFixedHeaderImage(source *objectRangeSource, extension, contentType string, length int64) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	data, err := source.ReadRange(0, metadataRangeLength(source, 0, length))
	if err != nil && err != io.EOF {
		return result, err
	}
	mergeMediaMetadata(&result.mediaMetadata, parseBoundedFileMetadata(data, extension, contentType, source.Size()))
	if width, height, ok := parseAdditionalImageDimensions(data, extension, contentType); ok {
		result.Width, result.Height = width, height
	}
	return result, nil
}

func inspectPNGMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	data, err := source.ReadRange(0, metadataRangeLength(source, 0, metadataGrowthFloor))
	if err != nil && err != io.EOF {
		return result, err
	}
	if len(data) < 24 || !bytes.Equal(data[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
		return result, nil
	}
	result.Width = int(binary.BigEndian.Uint32(data[16:20]))
	result.Height = int(binary.BigEndian.Uint32(data[20:24]))

	for offset, chunks := int64(8), 0; chunks < 4096; chunks++ {
		header, rangeErr := source.ReadRange(offset, metadataRangeLength(source, offset, 8))
		if rangeErr != nil && rangeErr != io.EOF {
			return result, rangeErr
		}
		if len(header) < 8 {
			break
		}
		length := int64(binary.BigEndian.Uint32(header[:4]))
		chunkType := string(header[4:8])
		if length < 0 || length > maxMetadataStructureBytes {
			return result, apiError{Status: 422, Code: "image_metadata_too_large", Message: "the PNG metadata chunk is too large to inspect safely"}
		}
		payloadStart := offset + 8
		switch chunkType {
		case "eXIf":
			payload, payloadErr := source.ReadRange(payloadStart, metadataRangeLength(source, payloadStart, length))
			if payloadErr != nil && payloadErr != io.EOF {
				return result, payloadErr
			}
			if exif := parseEXIFMetadata(payload); exif != nil {
				mergeMediaMetadata(&result.mediaMetadata, *exif)
			}
		case "tEXt", "iTXt":
			// Text chunks are metadata, but keep Details concise and avoid reading
			// unusually large text payloads.
			if length > 0 && length <= 256<<10 {
				payload, payloadErr := source.ReadRange(payloadStart, metadataRangeLength(source, payloadStart, length))
				if payloadErr == nil || payloadErr == io.EOF {
					parsePNGTextMetadata(&result.mediaMetadata, chunkType, payload)
				}
			}
		case "IDAT", "IEND":
			// PNG metadata relevant to Details belongs before the image stream in
			// normal files. Do not traverse image-data chunks merely to hunt for
			// optional trailing text.
			return result, nil
		}
		offset = payloadStart + length + 4 // payload plus CRC
		if source.Size() > 0 && offset >= source.Size() {
			break
		}
	}
	return result, nil
}

func parsePNGTextMetadata(metadata *mediaMetadata, chunkType string, payload []byte) {
	if metadata == nil || len(payload) == 0 {
		return
	}
	if chunkType == "tEXt" {
		if split := bytes.IndexByte(payload, 0); split > 0 {
			metadata.set(string(payload[:split]), string(payload[split+1:]))
		}
		return
	}
	// iTXt: keyword, compression flag/method, language, translated keyword,
	// then text. Compressed iTXt is intentionally skipped to avoid a decompressor
	// and unexpected CPU work in the metadata path.
	parts := bytes.SplitN(payload, []byte{0}, 6)
	if len(parts) == 6 && len(parts[1]) == 1 && parts[1][0] == 0 {
		metadata.set(string(parts[0]), string(parts[5]))
	}
}

func inspectWebPMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	prefix, err := source.ReadRange(0, metadataRangeLength(source, 0, metadataGrowthFloor))
	if err != nil && err != io.EOF {
		return result, err
	}
	if len(prefix) < 12 || !bytes.Equal(prefix[:4], []byte("RIFF")) || !bytes.Equal(prefix[8:12], []byte("WEBP")) {
		return result, nil
	}
	if width, height, ok := parseWebPDimensions(prefix); ok {
		result.Width, result.Height = width, height
	}
	for offset, chunks := int64(12), 0; chunks < 4096; chunks++ {
		header, rangeErr := source.ReadRange(offset, metadataRangeLength(source, offset, 8))
		if rangeErr != nil && rangeErr != io.EOF {
			return result, rangeErr
		}
		if len(header) < 8 {
			break
		}
		chunkType := string(header[:4])
		length := int64(binary.LittleEndian.Uint32(header[4:8]))
		if length < 0 || length > maxMetadataStructureBytes {
			return result, apiError{Status: 422, Code: "image_metadata_too_large", Message: "the WebP metadata chunk is too large to inspect safely"}
		}
		payloadStart := offset + 8
		switch chunkType {
		case "VP8X", "VP8L", "VP8 ":
			if result.Width == 0 || result.Height == 0 {
				readLength := minInt64(length, 64)
				payload, payloadErr := source.ReadRange(offset, metadataRangeLength(source, offset, 8+readLength))
				if payloadErr == nil || payloadErr == io.EOF {
					if width, height, ok := parseWebPDimensions(payload); ok {
						result.Width, result.Height = width, height
					}
				}
			}
		case "EXIF":
			payload, payloadErr := source.ReadRange(payloadStart, metadataRangeLength(source, payloadStart, length))
			if payloadErr != nil && payloadErr != io.EOF {
				return result, payloadErr
			}
			if exif := parseEXIFMetadata(payload); exif != nil {
				mergeMediaMetadata(&result.mediaMetadata, *exif)
			}
		case "XMP ":
			if length > 0 && length <= 256<<10 {
				payload, payloadErr := source.ReadRange(payloadStart, metadataRangeLength(source, payloadStart, length))
				if payloadErr == nil || payloadErr == io.EOF {
					result.set("XMP", strings.TrimSpace(string(payload)))
				}
			}
		}
		offset = payloadStart + length + length%2
		if source.Size() > 0 && offset >= source.Size() {
			break
		}
	}
	return result, nil
}

func inspectPNMMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	limit := minInt64(metadataStructureLimit(source), 1<<20)
	for target := int64(4 << 10); target <= limit; target = minInt64(limit, target*2) {
		data, err := source.ReadPrefix(metadataRangeLength(source, 0, target))
		if err != nil && err != io.EOF {
			return result, err
		}
		width, height, complete, valid := parsePNMDimensions(data)
		if !valid {
			return result, nil
		}
		if complete {
			result.Width, result.Height = width, height
			return result, nil
		}
		if int64(len(data)) < target || target == limit {
			break
		}
	}
	return result, nil
}

func parsePNMDimensions(data []byte) (width, height int, complete, valid bool) {
	if len(data) < 2 || data[0] != 'P' || data[1] < '1' || data[1] > '7' {
		return 0, 0, len(data) >= 2, false
	}
	if data[1] == '7' {
		text := strings.ReplaceAll(string(data), "\r\n", "\n")
		end := strings.Index(text, "\nENDHDR")
		if end < 0 {
			return 0, 0, false, true
		}
		for _, line := range strings.Split(text[:end], "\n") {
			fields := strings.Fields(line)
			if len(fields) != 2 {
				continue
			}
			value, err := strconv.Atoi(fields[1])
			if err != nil || value <= 0 {
				continue
			}
			switch strings.ToUpper(fields[0]) {
			case "WIDTH":
				width = value
			case "HEIGHT":
				height = value
			}
		}
		return width, height, true, width > 0 && height > 0
	}

	tokens := make([]string, 0, 4)
	for index := 2; index < len(data) && len(tokens) < 3; {
		for index < len(data) && (data[index] == ' ' || data[index] == '\t' || data[index] == '\r' || data[index] == '\n') {
			index++
		}
		if index >= len(data) {
			break
		}
		if data[index] == '#' {
			if newline := bytes.IndexByte(data[index:], '\n'); newline >= 0 {
				index += newline + 1
				continue
			}
			return 0, 0, false, true
		}
		start := index
		for index < len(data) && data[index] != ' ' && data[index] != '\t' && data[index] != '\r' && data[index] != '\n' && data[index] != '#' {
			index++
		}
		if start < index {
			tokens = append(tokens, string(data[start:index]))
		}
	}
	if len(tokens) < 2 {
		return 0, 0, false, true
	}
	width, widthErr := strconv.Atoi(tokens[0])
	height, heightErr := strconv.Atoi(tokens[1])
	return width, height, true, widthErr == nil && heightErr == nil && width > 0 && height > 0
}

func inspectRadianceHDRMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	limit := minInt64(metadataStructureLimit(source), 1<<20)
	for target := int64(4 << 10); target <= limit; target = minInt64(limit, target*2) {
		data, err := source.ReadPrefix(metadataRangeLength(source, 0, target))
		if err != nil && err != io.EOF {
			return result, err
		}
		width, height, complete, valid := parseRadianceHDRDimensions(data)
		if !valid {
			return result, nil
		}
		if complete {
			result.Width, result.Height = width, height
			return result, nil
		}
		if int64(len(data)) < target || target == limit {
			break
		}
	}
	return result, nil
}

func inspectFITSMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	limit := metadataStructureLimit(source)
	// FITS headers are a sequence of 2880-byte blocks containing 80-byte cards.
	// Stop as soon as the END card is found; image data is never read.
	for target := int64(2880); target <= limit; target = minInt64(limit, target+2880) {
		data, err := source.ReadPrefix(metadataRangeLength(source, 0, target))
		if err != nil && err != io.EOF {
			return result, err
		}
		width, height, complete, valid := parseFITSDimensions(data)
		if !valid {
			return result, nil
		}
		if complete {
			result.Width, result.Height = width, height
			return result, nil
		}
		if int64(len(data)) < target || target == limit {
			break
		}
	}
	return result, nil
}

func parseFITSDimensions(data []byte) (width, height int, complete, valid bool) {
	if len(data) < 80 {
		return 0, 0, false, true
	}
	if !strings.HasPrefix(string(data[:80]), "SIMPLE  =") && !strings.HasPrefix(string(data[:80]), "XTENSION=") {
		return 0, 0, true, false
	}
	for offset := 0; offset+80 <= len(data); offset += 80 {
		card := string(data[offset : offset+80])
		keyword := strings.TrimSpace(card[:8])
		if keyword == "END" {
			return width, height, true, width > 0 && height > 0
		}
		if len(card) < 10 || card[8] != '=' {
			continue
		}
		value := strings.TrimSpace(strings.SplitN(card[10:], "/", 2)[0])
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed <= 0 {
			continue
		}
		switch keyword {
		case "NAXIS1":
			width = parsed
		case "NAXIS2":
			height = parsed
		}
	}
	return width, height, false, true
}

func parseRadianceHDRDimensions(data []byte) (width, height int, complete, valid bool) {
	if len(data) >= 2 && !bytes.HasPrefix(data, []byte("#?")) {
		return 0, 0, true, false
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 4 {
			continue
		}
		var x, y int
		for index := 0; index < 4; index += 2 {
			value, err := strconv.Atoi(fields[index+1])
			if err != nil || value <= 0 {
				continue
			}
			switch strings.ToUpper(strings.TrimLeft(fields[index], "+-")) {
			case "X":
				x = value
			case "Y":
				y = value
			}
		}
		if x > 0 && y > 0 {
			return x, y, true, true
		}
	}
	return 0, 0, false, true
}

func inspectEXRMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	limit := metadataStructureLimit(source)
	for target := metadataGrowthFloor; target <= limit; target = minInt64(limit, target*2) {
		data, err := source.ReadPrefix(metadataRangeLength(source, 0, target))
		if err != nil && err != io.EOF {
			return result, err
		}
		width, height, required, complete, valid := parseEXRDimensions(data)
		if !valid {
			return result, nil
		}
		if complete {
			result.Width, result.Height = width, height
			return result, nil
		}
		if required > target {
			target = minInt64(limit, maxInt64(required-1, target))
		}
		if int64(len(data)) >= limit || int64(len(data)) < target {
			break
		}
	}
	return result, nil
}

func parseEXRDimensions(data []byte) (width, height int, required int64, complete, valid bool) {
	if len(data) < 8 {
		return 0, 0, 8, false, true
	}
	if binary.LittleEndian.Uint32(data[:4]) != 0x01312f76 {
		return 0, 0, 8, true, false
	}
	offset := 8
	for attributes := 0; attributes < 10000; attributes++ {
		nameEnd := bytes.IndexByte(data[offset:], 0)
		if nameEnd < 0 {
			return 0, 0, int64(len(data) + 256), false, true
		}
		nameEnd += offset
		if nameEnd == offset {
			return width, height, int64(nameEnd + 1), true, true
		}
		name := string(data[offset:nameEnd])
		offset = nameEnd + 1
		typeEnd := bytes.IndexByte(data[offset:], 0)
		if typeEnd < 0 {
			return 0, 0, int64(len(data) + 256), false, true
		}
		typeEnd += offset
		typeName := string(data[offset:typeEnd])
		offset = typeEnd + 1
		if offset+4 > len(data) {
			return 0, 0, int64(offset + 4), false, true
		}
		size := int64(binary.LittleEndian.Uint32(data[offset : offset+4]))
		offset += 4
		if size < 0 || size > maxMetadataStructureBytes {
			return 0, 0, int64(offset), true, false
		}
		end := int64(offset) + size
		if end > int64(len(data)) {
			return 0, 0, end, false, true
		}
		if name == "dataWindow" && typeName == "box2i" && size >= 16 {
			xMin := int32(binary.LittleEndian.Uint32(data[offset : offset+4]))
			yMin := int32(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
			xMax := int32(binary.LittleEndian.Uint32(data[offset+8 : offset+12]))
			yMax := int32(binary.LittleEndian.Uint32(data[offset+12 : offset+16]))
			if xMax >= xMin && yMax >= yMin {
				width = int(xMax-xMin) + 1
				height = int(yMax-yMin) + 1
			}
		}
		offset = int(end)
	}
	return width, height, int64(offset), true, false
}

func inspectJPEG2000Metadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	prefix, err := source.ReadRange(0, metadataRangeLength(source, 0, metadataGrowthFloor))
	if err != nil && err != io.EOF {
		return result, err
	}
	if width, height, ok := parseJ2KCodestreamDimensions(prefix); ok {
		result.Width, result.Height = width, height
		return result, nil
	}
	if len(prefix) < 12 || string(prefix[4:8]) != "jP  " {
		return result, nil
	}
	for offset, boxes := int64(0), 0; boxes < 4096 && (source.Size() <= 0 || offset+8 <= source.Size()); boxes++ {
		header, headerErr := readISOBoxHeader(source, offset)
		if headerErr != nil {
			return result, headerErr
		}
		if header.Size <= 0 || (source.Size() > 0 && offset+header.Size > source.Size()) {
			break
		}
		if header.Type == "jp2h" {
			if header.Size > maxMetadataStructureBytes {
				return result, apiError{Status: 422, Code: "image_metadata_too_large", Message: "the JPEG 2000 header is too large to inspect safely"}
			}
			box, readErr := source.ReadRange(offset, header.Size)
			if readErr != nil {
				return result, readErr
			}
			for _, payload := range findISOBoxPayloads(box, "ihdr") {
				if len(payload) >= 8 {
					height := int(binary.BigEndian.Uint32(payload[:4]))
					width := int(binary.BigEndian.Uint32(payload[4:8]))
					if width > 0 && height > 0 {
						result.Width, result.Height = width, height
						return result, nil
					}
				}
			}
		}
		if header.Type == "jp2c" {
			readLength := minInt64(header.Size-header.HeaderSize, metadataGrowthFloor)
			if readLength > 0 {
				codestream, readErr := source.ReadRange(offset+header.HeaderSize, readLength)
				if readErr == nil || readErr == io.EOF {
					if width, height, ok := parseJ2KCodestreamDimensions(codestream); ok {
						result.Width, result.Height = width, height
					}
				}
			}
			return result, nil
		}
		offset += header.Size
	}
	return result, nil
}

func parseJ2KCodestreamDimensions(data []byte) (int, int, bool) {
	if len(data) < 4 || data[0] != 0xff || data[1] != 0x4f {
		return 0, 0, false
	}
	for offset := 2; offset+4 <= len(data); {
		if data[offset] != 0xff {
			offset++
			continue
		}
		marker := data[offset+1]
		offset += 2
		if marker == 0x51 {
			if offset+2 > len(data) {
				return 0, 0, false
			}
			length := int(binary.BigEndian.Uint16(data[offset : offset+2]))
			if length < 38 || offset+length > len(data) {
				return 0, 0, false
			}
			payload := data[offset+2 : offset+length]
			xSize := binary.BigEndian.Uint32(payload[2:6])
			ySize := binary.BigEndian.Uint32(payload[6:10])
			xOrigin := binary.BigEndian.Uint32(payload[10:14])
			yOrigin := binary.BigEndian.Uint32(payload[14:18])
			if xSize > xOrigin && ySize > yOrigin {
				return int(xSize - xOrigin), int(ySize - yOrigin), true
			}
			return 0, 0, false
		}
		if marker == 0x93 || marker == 0xd9 {
			break
		}
		if offset+2 > len(data) {
			break
		}
		length := int(binary.BigEndian.Uint16(data[offset : offset+2]))
		if length < 2 || offset+length > len(data) {
			break
		}
		offset += length
	}
	return 0, 0, false
}

func inspectSVGMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	target := int64(4 << 10)
	limit := int64(1 << 20)
	for target <= limit {
		data, err := source.ReadPrefix(metadataRangeLength(source, 0, target))
		if err != nil && err != io.EOF {
			return result, err
		}
		lower := strings.ToLower(string(data))
		start := strings.Index(lower, "<svg")
		if start >= 0 {
			if end := strings.Index(lower[start:], ">"); end >= 0 {
				width, height := parseSVGStartTag(string(data[start : start+end+1]))
				result.Width, result.Height = width, height
				return result, nil
			}
		}
		if int64(len(data)) < target || target == limit {
			break
		}
		target = minInt64(limit, target*2)
	}
	return result, nil
}

func parseSVGStartTag(tag string) (int, int) {
	attributes := parseLooseXMLAttributes(tag)
	width := parseSVGLength(attributes["width"])
	height := parseSVGLength(attributes["height"])
	if width > 0 && height > 0 {
		return width, height
	}
	fields := strings.Fields(strings.ReplaceAll(attributes["viewbox"], ",", " "))
	if len(fields) == 4 {
		viewWidth, widthErr := strconv.ParseFloat(fields[2], 64)
		viewHeight, heightErr := strconv.ParseFloat(fields[3], 64)
		if widthErr == nil && heightErr == nil && viewWidth > 0 && viewHeight > 0 {
			return int(math.Round(viewWidth)), int(math.Round(viewHeight))
		}
	}
	return width, height
}

func parseLooseXMLAttributes(tag string) map[string]string {
	attributes := make(map[string]string)
	for index := 0; index < len(tag); {
		for index < len(tag) && (tag[index] == '<' || tag[index] == '>' || tag[index] == '/' || tag[index] == ' ' || tag[index] == '\t' || tag[index] == '\r' || tag[index] == '\n') {
			index++
		}
		start := index
		for index < len(tag) && tag[index] != '=' && tag[index] != ' ' && tag[index] != '\t' && tag[index] != '>' {
			index++
		}
		name := strings.ToLower(strings.TrimSpace(tag[start:index]))
		for index < len(tag) && (tag[index] == ' ' || tag[index] == '\t') {
			index++
		}
		if name == "" || index >= len(tag) || tag[index] != '=' {
			for index < len(tag) && tag[index] != ' ' && tag[index] != '>' {
				index++
			}
			continue
		}
		index++
		for index < len(tag) && (tag[index] == ' ' || tag[index] == '\t') {
			index++
		}
		if index >= len(tag) {
			break
		}
		quote := tag[index]
		if quote != '\'' && quote != '"' {
			continue
		}
		index++
		valueStart := index
		for index < len(tag) && tag[index] != quote {
			index++
		}
		attributes[name] = tag[valueStart:index]
		if index < len(tag) {
			index++
		}
	}
	return attributes
}

func parseSVGLength(value string) int {
	value = strings.TrimSpace(value)
	if value == "" || strings.HasSuffix(value, "%") {
		return 0
	}
	end := 0
	for end < len(value) && ((value[end] >= '0' && value[end] <= '9') || value[end] == '.' || value[end] == '+' || value[end] == '-') {
		end++
	}
	if end == 0 {
		return 0
	}
	number, err := strconv.ParseFloat(value[:end], 64)
	if err != nil || number <= 0 {
		return 0
	}
	return int(math.Round(number))
}

func isTIFFBasedImage(extension, contentType string) bool {
	switch extension {
	case "tif", "tiff", "dng", "cr2", "nef", "nrw", "arw", "srf", "sr2", "orf", "rw2", "pef", "erf", "mef", "mos", "kdc", "dcr", "mrw", "rwl", "iiq", "3fr", "fff", "raw":
		return true
	}
	return contentType == "image/tiff" || contentType == "image/x-adobe-dng"
}

func isHEIFImage(extension, contentType string) bool {
	switch extension {
	case "heic", "heif", "avif", "cr3":
		return true
	}
	return strings.Contains(contentType, "heif") || strings.Contains(contentType, "heic") || strings.Contains(contentType, "avif")
}

func readJPEGMetadataAt(source *objectRangeSource, start, available int64) (mediaMetadata, error) {
	result := newMediaMetadata()
	if available <= 0 && source.Size() > start {
		available = source.Size() - start
	}
	limit := maxMetadataStructureBytes
	if available > 0 {
		limit = minInt64(available, maxMetadataStructureBytes)
	}
	target := minInt64(limit, metadataGrowthFloor)
	for target > 0 {
		data, err := source.ReadRange(start, target)
		if err != nil && err != io.EOF {
			return result, err
		}
		required, done, valid := jpegHeaderRequirement(data)
		if !valid {
			return result, nil
		}
		if done || int64(len(data)) >= limit {
			mergeMediaMetadata(&result, parseBoundedFileMetadata(data, "jpeg", "image/jpeg", available))
			return result, nil
		}
		next := maxInt64(required, int64(len(data))*2+metadataGrowthFloor)
		if next <= int64(len(data)) {
			next = int64(len(data)) + metadataGrowthFloor
		}
		target = minInt64(limit, next)
	}
	return result, nil
}

func jpegHeaderRequirement(data []byte) (required int64, done, valid bool) {
	if len(data) < 2 {
		return 2, false, true
	}
	if data[0] != 0xff || data[1] != 0xd8 {
		return 0, true, false
	}
	offset := 2
	for {
		for offset < len(data) && data[offset] != 0xff {
			offset++
		}
		if offset >= len(data) {
			return int64(offset + 1), false, true
		}
		for offset < len(data) && data[offset] == 0xff {
			offset++
		}
		if offset >= len(data) {
			return int64(offset + 1), false, true
		}
		marker := data[offset]
		offset++
		if marker == 0xd9 {
			return int64(offset), true, true
		}
		if marker == 0xd8 || marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7) {
			continue
		}
		if offset+2 > len(data) {
			return int64(offset + 2), false, true
		}
		length := int(binary.BigEndian.Uint16(data[offset : offset+2]))
		if length < 2 {
			return int64(offset + 2), true, false
		}
		segmentEnd := offset + length
		if segmentEnd > len(data) {
			return int64(segmentEnd), false, true
		}
		offset = segmentEnd
		if marker == 0xda { // Start of scan: metadata header is complete.
			return int64(offset), true, true
		}
	}
}

func inspectRAFMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	header, err := source.ReadRange(0, metadataRangeLength(source, 0, 128))
	if err != nil && err != io.EOF {
		return result, err
	}
	offset, length, ok := rafPreviewRange(header)
	if !ok || offset < 0 || length <= 0 || (source.Size() > 0 && offset >= source.Size()) {
		return result, nil
	}
	if source.Size() > 0 {
		length = minInt64(length, source.Size()-offset)
	}
	metadata, err := readJPEGMetadataAt(source, offset, length)
	mergeMediaMetadata(&result.mediaMetadata, metadata)
	return result, err
}

func inspectTIFFMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	data, valid, err := readAdaptiveTIFFHeader(source)
	if err != nil {
		return result, err
	}
	if !valid {
		return result, nil
	}
	if exif := parseEXIFMetadata(data); exif != nil {
		mergeMediaMetadata(&result.mediaMetadata, *exif)
	}
	if offset, length, ok := embeddedTIFFJPEGRange(data); ok && offset >= 0 && length > 0 && (source.Size() <= 0 || offset < source.Size()) {
		metadata, rangeErr := readJPEGMetadataAt(source, offset, metadataRangeLength(source, offset, length))
		if rangeErr == nil {
			mergeMediaMetadata(&result.mediaMetadata, metadata)
		}
	}
	return result, nil
}

func readAdaptiveTIFFHeader(source *objectRangeSource) ([]byte, bool, error) {
	// The first request is deliberately large enough to cover the complete IFD
	// tree of most camera files. Further requests are made only for offsets and
	// lengths explicitly declared by the TIFF/RAW metadata structures.
	header, err := source.ReadRange(0, metadataRangeLength(source, 0, metadataGrowthFloor))
	if err != nil && err != io.EOF {
		return nil, false, err
	}
	layout, valid := parseTIFFLayout(header)
	if !valid {
		return header, false, nil
	}

	data := append([]byte(nil), header...)
	place := func(offset, length int64) ([]byte, error) {
		if offset < 0 || length <= 0 || offset > maxMetadataStructureBytes || length > maxMetadataStructureBytes-offset {
			return nil, apiError{Status: 422, Code: "image_metadata_too_large", Message: "the TIFF metadata structure is too large to inspect safely"}
		}
		if source.Size() > 0 && (offset > source.Size() || length > source.Size()-offset) {
			return nil, io.ErrUnexpectedEOF
		}
		chunk, readErr := source.ReadRange(offset, metadataRangeLength(source, offset, length))
		if readErr != nil && readErr != io.EOF {
			return nil, readErr
		}
		if int64(len(chunk)) < length {
			return nil, io.ErrUnexpectedEOF
		}
		if source.BytesRead() > maxMetadataStructureBytes {
			return nil, apiError{Status: 422, Code: "image_metadata_too_large", Message: "the TIFF metadata structure is too large to inspect safely"}
		}
		required := offset + length
		if required > int64(len(data)) {
			data = append(data, make([]byte, int(required)-len(data))...)
		}
		copy(data[int(offset):int(required)], chunk[:length])
		return data[int(offset):int(required)], nil
	}

	readCount := func(raw []byte) uint64 {
		if layout.bigTIFF {
			return layout.order.Uint64(raw[:8])
		}
		return uint64(layout.order.Uint16(raw[:2]))
	}
	readOffset := func(raw []byte) uint64 {
		if layout.bigTIFF {
			return layout.order.Uint64(raw[:8])
		}
		return uint64(layout.order.Uint32(raw[:4]))
	}
	type byteRange struct{ start, end int64 }
	queue := []uint64{layout.firstIFD}
	visited := make(map[uint64]struct{})
	for len(queue) > 0 {
		offset := queue[0]
		queue = queue[1:]
		if offset == 0 {
			continue
		}
		if _, ok := visited[offset]; ok {
			continue
		}
		visited[offset] = struct{}{}
		if len(visited) > 256 {
			return data, true, nil
		}
		if offset > uint64(maxMetadataStructureBytes) {
			return data, false, apiError{Status: 422, Code: "image_metadata_too_large", Message: "the TIFF metadata structure is too large to inspect safely"}
		}

		countBytes, readErr := place(int64(offset), int64(layout.countSize))
		if readErr != nil {
			return data, false, readErr
		}
		count := readCount(countBytes)
		if count > 4096 {
			return data, false, apiError{Status: 422, Code: "invalid_image_metadata", Message: "the TIFF metadata table has too many entries"}
		}
		tableLength := int64(layout.countSize) + int64(count)*int64(layout.entrySize) + int64(layout.nextOffsetSize)
		table, readErr := place(int64(offset), tableLength)
		if readErr != nil {
			return data, false, readErr
		}

		ranges := make([]byteRange, 0)
		for index := uint64(0); index < count; index++ {
			cursor := layout.countSize + int(index)*layout.entrySize
			entry := table[cursor : cursor+layout.entrySize]
			tag := layout.order.Uint16(entry[:2])
			typeID := layout.order.Uint16(entry[2:4])
			var valueCount uint64
			var valueBytes []byte
			if layout.bigTIFF {
				valueCount = layout.order.Uint64(entry[4:12])
				valueBytes = entry[12:20]
			} else {
				valueCount = uint64(layout.order.Uint32(entry[4:8]))
				valueBytes = entry[8:12]
			}
			typeSize := tiffTypeSize(typeID)
			if typeSize <= 0 || valueCount > uint64(maxMetadataStructureBytes/typeSize) {
				continue
			}
			valueSize := typeSize * int64(valueCount)
			if valueSize > layout.inlineValueSize && tiffMetadataTag(tag) {
				valueOffset := readOffset(valueBytes)
				if valueOffset <= uint64(maxMetadataStructureBytes) && valueSize > 0 && valueSize <= maxMetadataStructureBytes-int64(valueOffset) {
					ranges = append(ranges, byteRange{start: int64(valueOffset), end: int64(valueOffset) + valueSize})
				}
			}
		}

		// Nearby IFD values are combined into one provider request. The small
		// amount of intentional over-read is cheaper than one S3/GCS operation per
		// EXIF scalar or string and remains inside the metadata structure.
		sort.Slice(ranges, func(i, j int) bool { return ranges[i].start < ranges[j].start })
		merged := make([]byteRange, 0, len(ranges))
		for _, item := range ranges {
			if item.start < 0 || item.end <= item.start || item.end > maxMetadataStructureBytes {
				continue
			}
			if len(merged) > 0 && item.start <= merged[len(merged)-1].end+4096 {
				if item.end > merged[len(merged)-1].end {
					merged[len(merged)-1].end = item.end
				}
				continue
			}
			merged = append(merged, item)
		}
		for _, item := range merged {
			if _, readErr := place(item.start, item.end-item.start); readErr != nil {
				return data, false, readErr
			}
		}

		for index := uint64(0); index < count; index++ {
			cursor := layout.countSize + int(index)*layout.entrySize
			entry := table[cursor : cursor+layout.entrySize]
			tag := layout.order.Uint16(entry[:2])
			typeID := layout.order.Uint16(entry[2:4])
			var valueCount uint64
			var valueBytes []byte
			if layout.bigTIFF {
				valueCount = layout.order.Uint64(entry[4:12])
				valueBytes = entry[12:20]
			} else {
				valueCount = uint64(layout.order.Uint32(entry[4:8]))
				valueBytes = entry[8:12]
			}
			typeSize := tiffTypeSize(typeID)
			if typeSize <= 0 || valueCount > uint64(maxMetadataStructureBytes/typeSize) {
				continue
			}
			valueSize := typeSize * int64(valueCount)
			if valueSize > layout.inlineValueSize {
				valueOffset := readOffset(valueBytes)
				if valueOffset <= uint64(len(data)) && valueSize <= int64(len(data))-int64(valueOffset) {
					valueBytes = data[int(valueOffset) : int64(valueOffset)+valueSize]
				}
			}
			if tag == 0x8769 || tag == 0x8825 {
				if child := tiffFirstUint(layout.order, typeID, valueBytes); child > 0 {
					queue = append(queue, child)
				}
			}
			if tag == 0x014a {
				for _, child := range tiffUintValues(layout.order, typeID, valueBytes, int(minInt64(int64(valueCount), 4096))) {
					if child > 0 {
						queue = append(queue, child)
					}
				}
			}
		}
		nextStart := len(table) - layout.nextOffsetSize
		next := readOffset(table[nextStart:])
		if next > 0 {
			queue = append(queue, next)
		}
	}
	return data, true, nil
}

func tiffMetadataTag(tag uint16) bool {
	switch tag {
	case 0x0100, 0x0101, 0x010f, 0x0110, 0x0112, 0x0131, 0x0132,
		0x014a, 0x0201, 0x0202, 0x829a, 0x829d, 0x8769, 0x8825, 0x8827,
		0x9003, 0x920a, 0xa002, 0xa003, 0xa405, 0xa433, 0xa434,
		0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006:
		return true
	default:
		return false
	}
}

func tiffFirstUint(order binary.ByteOrder, typeID uint16, data []byte) uint64 {
	values := tiffUintValues(order, typeID, data, 1)
	if len(values) == 0 {
		return 0
	}
	return values[0]
}

func tiffUintValues(order binary.ByteOrder, typeID uint16, data []byte, count int) []uint64 {
	if count <= 0 {
		return nil
	}
	out := make([]uint64, 0, count)
	switch typeID {
	case 1, 6, 7:
		for index := 0; index < count && index < len(data); index++ {
			out = append(out, uint64(data[index]))
		}
	case 3, 8:
		for index := 0; index < count && index*2+2 <= len(data); index++ {
			out = append(out, uint64(order.Uint16(data[index*2:index*2+2])))
		}
	case 4, 9:
		for index := 0; index < count && index*4+4 <= len(data); index++ {
			out = append(out, uint64(order.Uint32(data[index*4:index*4+4])))
		}
	}
	return out
}

type isoBoxHeader struct {
	Offset     int64
	Size       int64
	HeaderSize int64
	Type       string
}

func inspectISOMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	var selected []byte
	for offset, count := int64(0), 0; count < 4096 && (source.Size() <= 0 || offset+8 <= source.Size()); count++ {
		if !source.hasByte(offset) {
			if _, err := source.ReadRange(offset, metadataRangeLength(source, offset, metadataGrowthFloor)); err != nil && err != io.EOF {
				return result, err
			}
		}
		header, err := readISOBoxHeader(source, offset)
		if err != nil {
			return result, err
		}
		if header.Size <= 0 || (source.Size() > 0 && header.Offset+header.Size > source.Size()) {
			break
		}
		if header.Type == "moov" || header.Type == "meta" {
			if header.Size > maxMetadataStructureBytes {
				return result, apiError{Status: 422, Code: "media_metadata_too_large", Message: "the media metadata structure is too large to inspect safely"}
			}
			selected, err = source.ReadRange(header.Offset, header.Size)
			if err != nil {
				return result, err
			}
			if header.Type == "moov" {
				break
			}
		}
		offset += header.Size
	}
	if len(selected) == 0 {
		return result, nil
	}
	width, height, duration, codecs := parseISOBaseMedia([][]byte{selected})
	result.Width, result.Height, result.DurationSeconds, result.Codecs = width, height, duration, codecs
	if width == 0 || height == 0 {
		if candidateWidth, candidateHeight := parseISPEImageDimensions(selected); candidateWidth > 0 && candidateHeight > 0 {
			result.Width, result.Height = candidateWidth, candidateHeight
		}
	}
	result.Tracks = parseISOTracks(selected)
	if len(result.Codecs) == 0 {
		for _, track := range result.Tracks {
			if track.Codec != "" {
				result.Codecs = appendUniqueString(result.Codecs, track.Codec)
			}
		}
	}
	return result, nil
}

func readISOBoxHeader(source *objectRangeSource, offset int64) (isoBoxHeader, error) {
	data, err := source.ReadRange(offset, metadataRangeLength(source, offset, 16))
	if err != nil {
		return isoBoxHeader{}, err
	}
	if len(data) < 8 {
		return isoBoxHeader{}, io.ErrUnexpectedEOF
	}
	size := int64(binary.BigEndian.Uint32(data[:4]))
	headerSize := int64(8)
	if size == 1 {
		if len(data) < 16 {
			return isoBoxHeader{}, io.ErrUnexpectedEOF
		}
		size = int64(binary.BigEndian.Uint64(data[8:16]))
		headerSize = 16
	} else if size == 0 {
		size = source.Size() - offset
	}
	if size < headerSize {
		return isoBoxHeader{}, fmt.Errorf("invalid ISO base media box size")
	}
	return isoBoxHeader{Offset: offset, Size: size, HeaderSize: headerSize, Type: string(data[4:8])}, nil
}

type isoBoxView struct {
	Type    string
	Start   int
	End     int
	Payload []byte
}

func isoChildBoxes(data []byte, start, end int) []isoBoxView {
	if start < 0 {
		start = 0
	}
	if end > len(data) {
		end = len(data)
	}
	out := make([]isoBoxView, 0)
	for offset, count := start, 0; offset+8 <= end && count < 10000; count++ {
		size := int64(binary.BigEndian.Uint32(data[offset : offset+4]))
		typeName := string(data[offset+4 : offset+8])
		headerSize := 8
		if size == 1 {
			if offset+16 > end {
				break
			}
			size = int64(binary.BigEndian.Uint64(data[offset+8 : offset+16]))
			headerSize = 16
		} else if size == 0 {
			size = int64(end - offset)
		}
		if size < int64(headerSize) || int64(offset)+size > int64(end) {
			break
		}
		boxEnd := offset + int(size)
		out = append(out, isoBoxView{Type: typeName, Start: offset, End: boxEnd, Payload: data[offset+headerSize : boxEnd]})
		offset = boxEnd
	}
	return out
}

func isoFindChild(data []byte, typeName string) (isoBoxView, bool) {
	for _, box := range isoChildBoxes(data, 0, len(data)) {
		if box.Type == typeName {
			return box, true
		}
	}
	return isoBoxView{}, false
}

func parseISOTracks(data []byte) []mediaTrackInfo {
	root := isoChildBoxes(data, 0, len(data))
	var moovPayload []byte
	for _, box := range root {
		if box.Type == "moov" {
			moovPayload = box.Payload
			break
		}
	}
	if moovPayload == nil {
		return nil
	}
	tracks := make([]mediaTrackInfo, 0)
	for _, trak := range isoChildBoxes(moovPayload, 0, len(moovPayload)) {
		if trak.Type != "trak" {
			continue
		}
		track := mediaTrackInfo{Index: len(tracks)}
		if tkhd, ok := isoFindChild(trak.Payload, "tkhd"); ok {
			track.Width, track.Height = parseTKHDDimensions(tkhd.Payload)
		}
		mdia, ok := isoFindChild(trak.Payload, "mdia")
		if !ok {
			continue
		}
		if hdlr, ok := isoFindChild(mdia.Payload, "hdlr"); ok && len(hdlr.Payload) >= 12 {
			switch string(hdlr.Payload[8:12]) {
			case "vide":
				track.Type = "video"
			case "soun":
				track.Type = "audio"
			case "subt", "sbtl", "text", "clcp":
				track.Type = "subtitle"
			default:
				track.Type = strings.TrimSpace(string(hdlr.Payload[8:12]))
			}
		}
		if mdhd, ok := isoFindChild(mdia.Payload, "mdhd"); ok {
			track.Language = parseMDHDLanguage(mdhd.Payload)
		}
		if minf, ok := isoFindChild(mdia.Payload, "minf"); ok {
			if stbl, ok := isoFindChild(minf.Payload, "stbl"); ok {
				if stsd, ok := isoFindChild(stbl.Payload, "stsd"); ok {
					parseISOTrackSampleEntry(&track, stsd.Payload)
				}
			}
		}
		if track.Type != "" {
			tracks = append(tracks, track)
		}
	}
	for index := range tracks {
		tracks[index].Index = index
	}
	return tracks
}

func parseISOTrackSampleEntry(track *mediaTrackInfo, payload []byte) {
	if len(payload) < 16 {
		return
	}
	entrySize := int(binary.BigEndian.Uint32(payload[8:12]))
	if entrySize < 8 || 8+entrySize > len(payload) {
		return
	}
	track.Codec = string(payload[12:16])
	entryPayload := payload[16 : 8+entrySize]
	if track.Type == "video" && len(entryPayload) >= 28 {
		if width := int(binary.BigEndian.Uint16(entryPayload[24:26])); width > 0 {
			track.Width = width
		}
		if height := int(binary.BigEndian.Uint16(entryPayload[26:28])); height > 0 {
			track.Height = height
		}
	}
	if track.Type == "audio" && len(entryPayload) >= 28 {
		track.Channels = int(binary.BigEndian.Uint16(entryPayload[16:18]))
		track.SampleRate = int(binary.BigEndian.Uint32(entryPayload[24:28]) >> 16)
	}
}

func parseMDHDLanguage(payload []byte) string {
	if len(payload) < 24 {
		return ""
	}
	offset := 20
	if payload[0] == 1 {
		offset = 32
	}
	if offset+2 > len(payload) {
		return ""
	}
	packed := binary.BigEndian.Uint16(payload[offset : offset+2])
	if packed == 0 {
		return ""
	}
	letters := []byte{
		byte((packed>>10)&0x1f) + 0x60,
		byte((packed>>5)&0x1f) + 0x60,
		byte(packed&0x1f) + 0x60,
	}
	for _, letter := range letters {
		if letter < 'a' || letter > 'z' {
			return ""
		}
	}
	return string(letters)
}

func parseISPEImageDimensions(data []byte) (int, int) {
	for _, payload := range findISOBoxPayloads(data, "ispe") {
		if len(payload) >= 12 {
			width := int(binary.BigEndian.Uint32(payload[4:8]))
			height := int(binary.BigEndian.Uint32(payload[8:12]))
			if width > 0 && height > 0 {
				return width, height
			}
		}
	}
	return 0, 0
}

func inspectMatroskaMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	limit := metadataStructureLimit(source)
	target := minInt64(limit, 1<<20)
	for target > 0 {
		data, err := source.ReadPrefix(target)
		if err != nil && err != io.EOF {
			return result, err
		}
		metadata, complete, valid := parseMatroskaHeader(data)
		if !valid {
			return result, nil
		}
		result = metadata
		if complete || int64(len(data)) >= limit {
			return result, nil
		}
		target = minInt64(limit, maxInt64(int64(len(data))*2, int64(len(data))+1<<20))
	}
	return result, nil
}

func parseMatroskaHeader(data []byte) (adaptiveMediaMetadata, bool, bool) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	if len(data) < 4 || !bytes.Equal(data[:4], []byte{0x1a, 0x45, 0xdf, 0xa3}) {
		return result, true, false
	}
	segmentOffset := -1
	for offset := 0; offset < len(data); {
		id, idLen, _, ok := readEBMLVInt(data, offset, true)
		if !ok {
			return result, false, true
		}
		size, sizeLen, unknown, ok := readEBMLVInt(data, offset+idLen, false)
		if !ok {
			return result, false, true
		}
		payload := offset + idLen + sizeLen
		if id == 0x18538067 {
			segmentOffset = payload
			_ = size
			_ = unknown
			break
		}
		if unknown || size > uint64(len(data)-payload) {
			return result, false, true
		}
		offset = payload + int(size)
	}
	if segmentOffset < 0 {
		return result, false, true
	}
	timecodeScale := float64(1_000_000)
	durationUnits := float64(0)
	infoFound, tracksFound := false, false
	for offset := segmentOffset; offset < len(data); {
		id, idLen, _, ok := readEBMLVInt(data, offset, true)
		if !ok {
			return result, false, true
		}
		size, sizeLen, unknown, ok := readEBMLVInt(data, offset+idLen, false)
		if !ok {
			return result, false, true
		}
		payload := offset + idLen + sizeLen
		if id == 0x1f43b675 { // Cluster: header metadata is complete.
			if durationUnits > 0 {
				result.DurationSeconds = durationUnits * timecodeScale / 1_000_000_000
			}
			return result, true, true
		}
		if unknown || size > uint64(len(data)-payload) {
			return result, false, true
		}
		end := payload + int(size)
		switch id {
		case 0x1549a966: // Info
			infoFound = true
			timecodeScale, durationUnits = parseMatroskaInfo(data[payload:end], timecodeScale, durationUnits, &result.mediaMetadata)
		case 0x1654ae6b: // Tracks
			tracksFound = true
			result.Tracks = parseMatroskaTracks(data[payload:end])
			for _, track := range result.Tracks {
				if track.Codec != "" {
					result.Codecs = appendUniqueString(result.Codecs, track.Codec)
				}
				if track.Type == "video" && track.Width*track.Height > result.Width*result.Height {
					result.Width, result.Height = track.Width, track.Height
				}
			}
		}
		offset = end
	}
	if durationUnits > 0 {
		result.DurationSeconds = durationUnits * timecodeScale / 1_000_000_000
	}
	return result, infoFound && tracksFound, true
}

func readEBMLVInt(data []byte, offset int, keepMarker bool) (uint64, int, bool, bool) {
	if offset < 0 || offset >= len(data) {
		return 0, 0, false, false
	}
	first := data[offset]
	mask := byte(0x80)
	length := 1
	for length <= 8 && first&mask == 0 {
		mask >>= 1
		length++
	}
	if length > 8 || offset+length > len(data) {
		return 0, 0, false, false
	}
	value := uint64(first)
	if !keepMarker {
		value = uint64(first &^ mask)
	}
	for index := 1; index < length; index++ {
		value = value<<8 | uint64(data[offset+index])
	}
	unknown := false
	if !keepMarker {
		unknownValue := uint64(1)<<(7*length) - 1
		unknown = value == unknownValue
	}
	return value, length, unknown, true
}

func parseMatroskaInfo(data []byte, scale, duration float64, metadata *mediaMetadata) (float64, float64) {
	for offset := 0; offset < len(data); {
		id, idLen, _, ok := readEBMLVInt(data, offset, true)
		if !ok {
			break
		}
		size, sizeLen, unknown, ok := readEBMLVInt(data, offset+idLen, false)
		if !ok || unknown {
			break
		}
		payload := offset + idLen + sizeLen
		if size > uint64(len(data)-payload) {
			break
		}
		value := data[payload : payload+int(size)]
		switch id {
		case 0x2ad7b1:
			if number := ebmlUnsigned(value); number > 0 {
				scale = float64(number)
			}
		case 0x4489:
			duration = ebmlFloat(value)
		case 0x7ba9:
			metadata.set("Title", string(value))
		case 0x4d80:
			metadata.set("Muxing application", string(value))
		case 0x5741:
			metadata.set("Writing application", string(value))
		}
		offset = payload + int(size)
	}
	return scale, duration
}

func parseMatroskaTracks(data []byte) []mediaTrackInfo {
	tracks := make([]mediaTrackInfo, 0)
	for offset := 0; offset < len(data); {
		id, idLen, _, ok := readEBMLVInt(data, offset, true)
		if !ok {
			break
		}
		size, sizeLen, unknown, ok := readEBMLVInt(data, offset+idLen, false)
		if !ok || unknown {
			break
		}
		payload := offset + idLen + sizeLen
		if size > uint64(len(data)-payload) {
			break
		}
		if id == 0xae {
			track := parseMatroskaTrackEntry(data[payload : payload+int(size)])
			track.Index = len(tracks)
			if track.Type != "" {
				tracks = append(tracks, track)
			}
		}
		offset = payload + int(size)
	}
	return tracks
}

func parseMatroskaTrackEntry(data []byte) mediaTrackInfo {
	track := mediaTrackInfo{}
	for offset := 0; offset < len(data); {
		id, idLen, _, ok := readEBMLVInt(data, offset, true)
		if !ok {
			break
		}
		size, sizeLen, unknown, ok := readEBMLVInt(data, offset+idLen, false)
		if !ok || unknown {
			break
		}
		payload := offset + idLen + sizeLen
		if size > uint64(len(data)-payload) {
			break
		}
		value := data[payload : payload+int(size)]
		switch id {
		case 0x83:
			switch ebmlUnsigned(value) {
			case 1:
				track.Type = "video"
			case 2:
				track.Type = "audio"
			case 17:
				track.Type = "subtitle"
			}
		case 0x86:
			track.Codec = string(value)
		case 0x536e:
			track.Title = string(value)
		case 0x22b59c:
			track.Language = string(value)
		case 0x88:
			track.Default = ebmlUnsigned(value) != 0
		case 0xe0:
			parseMatroskaVideo(value, &track)
		case 0xe1:
			parseMatroskaAudio(value, &track)
		}
		offset = payload + int(size)
	}
	return track
}

func parseMatroskaVideo(data []byte, track *mediaTrackInfo) {
	walkSimpleEBML(data, func(id uint64, value []byte) {
		switch id {
		case 0xb0:
			track.Width = int(ebmlUnsigned(value))
		case 0xba:
			track.Height = int(ebmlUnsigned(value))
		}
	})
}

func parseMatroskaAudio(data []byte, track *mediaTrackInfo) {
	walkSimpleEBML(data, func(id uint64, value []byte) {
		switch id {
		case 0xb5:
			track.SampleRate = int(math.Round(ebmlFloat(value)))
		case 0x9f:
			track.Channels = int(ebmlUnsigned(value))
		}
	})
}

func walkSimpleEBML(data []byte, visit func(uint64, []byte)) {
	for offset := 0; offset < len(data); {
		id, idLen, _, ok := readEBMLVInt(data, offset, true)
		if !ok {
			return
		}
		size, sizeLen, unknown, ok := readEBMLVInt(data, offset+idLen, false)
		if !ok || unknown {
			return
		}
		payload := offset + idLen + sizeLen
		if size > uint64(len(data)-payload) {
			return
		}
		visit(id, data[payload:payload+int(size)])
		offset = payload + int(size)
	}
}

func ebmlUnsigned(data []byte) uint64 {
	var value uint64
	for _, item := range data {
		value = value<<8 | uint64(item)
	}
	return value
}

func ebmlFloat(data []byte) float64 {
	switch len(data) {
	case 4:
		return float64(math.Float32frombits(binary.BigEndian.Uint32(data)))
	case 8:
		return math.Float64frombits(binary.BigEndian.Uint64(data))
	default:
		return 0
	}
}

func inspectMP3Metadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	header, err := source.ReadRange(0, metadataRangeLength(source, 0, 10))
	if err != nil && err != io.EOF {
		return result, err
	}
	target := metadataGrowthFloor
	if len(header) >= 10 && string(header[:3]) == "ID3" {
		target = int64(10 + synchsafeUint32(header[6:10]) + 64<<10)
	}
	target = minInt64(metadataStructureLimit(source), maxInt64(target, metadataGrowthFloor))
	data, err := source.ReadPrefix(target)
	if err != nil && err != io.EOF {
		return result, err
	}
	mergeMediaMetadata(&result.mediaMetadata, parseMP3Metadata(data, source.Size()))
	return result, nil
}

func inspectFLACMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	target := metadataRangeLength(source, 0, metadataGrowthFloor)
	for target > 0 {
		data, err := source.ReadPrefix(target)
		if err != nil && err != io.EOF {
			return result, err
		}
		required, complete := flacMetadataRequirement(data)
		if complete || int64(len(data)) >= metadataStructureLimit(source) {
			mergeMediaMetadata(&result.mediaMetadata, parseFLACMetadata(data))
			return result, nil
		}
		target = minInt64(metadataStructureLimit(source), maxInt64(required, int64(len(data))*2))
	}
	return result, nil
}

func flacMetadataRequirement(data []byte) (int64, bool) {
	if len(data) < 4 || string(data[:4]) != "fLaC" {
		return 4, true
	}
	offset := 4
	for {
		if offset+4 > len(data) {
			return int64(offset + 4), false
		}
		last := data[offset]&0x80 != 0
		length := int(data[offset+1])<<16 | int(data[offset+2])<<8 | int(data[offset+3])
		offset += 4
		if offset+length > len(data) {
			return int64(offset + length), false
		}
		offset += length
		if last {
			return int64(offset), true
		}
	}
}

func inspectWAVMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	target := metadataRangeLength(source, 0, metadataGrowthFloor)
	for target > 0 {
		data, err := source.ReadPrefix(target)
		if err != nil && err != io.EOF {
			return result, err
		}
		required, complete := riffMetadataRequirement(data)
		if complete || int64(len(data)) >= minInt64(source.Size(), maxMetadataStructureBytes) {
			mergeMediaMetadata(&result.mediaMetadata, parseWAVMetadata(data))
			return result, nil
		}
		target = minInt64(metadataStructureLimit(source), maxInt64(required, int64(len(data))*2))
	}
	return result, nil
}

func riffMetadataRequirement(data []byte) (int64, bool) {
	if len(data) < 12 || string(data[:4]) != "RIFF" {
		return 12, true
	}
	offset := 12
	for offset+8 <= len(data) {
		chunkType := string(data[offset : offset+4])
		chunkLength := int64(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		if chunkType == "data" {
			return int64(offset + 8), true
		}
		next := int64(offset+8) + chunkLength + chunkLength%2
		if next > int64(len(data)) {
			return next, false
		}
		offset = int(next)
	}
	return int64(offset + 8), false
}

func inspectOggMetadata(source *objectRangeSource) (adaptiveMediaMetadata, error) {
	result := adaptiveMediaMetadata{mediaMetadata: newMediaMetadata()}
	prefix, err := source.ReadRange(0, metadataRangeLength(source, 0, metadataGrowthFloor))
	if err != nil && err != io.EOF {
		return result, err
	}
	sampleRate := 0
	if index := bytes.Index(prefix, []byte("OpusHead")); index >= 0 && index+19 <= len(prefix) {
		result.Codecs = []string{"opus"}
		sampleRate = 48000
		result.Properties["Channels"] = strconv.Itoa(int(prefix[index+9]))
	} else if index := bytes.Index(prefix, []byte{1, 'v', 'o', 'r', 'b', 'i', 's'}); index >= 0 && index+16 <= len(prefix) {
		result.Codecs = []string{"vorbis"}
		result.Properties["Channels"] = strconv.Itoa(int(prefix[index+11]))
		sampleRate = int(binary.LittleEndian.Uint32(prefix[index+12 : index+16]))
	}
	if sampleRate > 0 && source.Size() > 0 {
		tailLength := minInt64(source.Size(), metadataGrowthFloor)
		tail, tailErr := source.ReadRange(source.Size()-tailLength, tailLength)
		if tailErr == nil {
			if granule, ok := lastOggGranule(tail); ok {
				result.DurationSeconds = float64(granule) / float64(sampleRate)
			}
		}
	}
	return result, nil
}

func lastOggGranule(data []byte) (uint64, bool) {
	for offset := len(data) - 27; offset >= 0; offset-- {
		if offset+14 <= len(data) && string(data[offset:offset+4]) == "OggS" {
			return binary.LittleEndian.Uint64(data[offset+6 : offset+14]), true
		}
	}
	return 0, false
}

func parseAdditionalImageDimensions(data []byte, extension, contentType string) (int, int, bool) {
	extension = strings.ToLower(extension)
	switch extension {
	case "bmp", "dib":
		if len(data) >= 26 && string(data[:2]) == "BM" {
			width := int(int32(binary.LittleEndian.Uint32(data[18:22])))
			height := int(int32(binary.LittleEndian.Uint32(data[22:26])))
			if height < 0 {
				height = -height
			}
			return width, height, width > 0 && height > 0
		}
	case "psd", "psb":
		if len(data) >= 26 && string(data[:4]) == "8BPS" {
			height := int(binary.BigEndian.Uint32(data[14:18]))
			width := int(binary.BigEndian.Uint32(data[18:22]))
			return width, height, width > 0 && height > 0
		}
	case "tga":
		if len(data) >= 18 {
			width := int(binary.LittleEndian.Uint16(data[12:14]))
			height := int(binary.LittleEndian.Uint16(data[14:16]))
			return width, height, width > 0 && height > 0
		}
	case "ico", "cur":
		if len(data) >= 8 && binary.LittleEndian.Uint16(data[0:2]) == 0 && binary.LittleEndian.Uint16(data[4:6]) > 0 {
			width, height := int(data[6]), int(data[7])
			if width == 0 {
				width = 256
			}
			if height == 0 {
				height = 256
			}
			return width, height, true
		}
	case "dds":
		if len(data) >= 20 && string(data[:4]) == "DDS " {
			height := int(binary.LittleEndian.Uint32(data[12:16]))
			width := int(binary.LittleEndian.Uint32(data[16:20]))
			return width, height, width > 0 && height > 0
		}
	case "pcx":
		if len(data) >= 12 && data[0] == 0x0a {
			xMin := int(binary.LittleEndian.Uint16(data[4:6]))
			yMin := int(binary.LittleEndian.Uint16(data[6:8]))
			xMax := int(binary.LittleEndian.Uint16(data[8:10]))
			yMax := int(binary.LittleEndian.Uint16(data[10:12]))
			width, height := xMax-xMin+1, yMax-yMin+1
			return width, height, width > 0 && height > 0
		}
	case "sgi", "rgb", "rgba", "bw":
		if len(data) >= 10 && binary.BigEndian.Uint16(data[:2]) == 0x01da {
			width := int(binary.BigEndian.Uint16(data[6:8]))
			height := int(binary.BigEndian.Uint16(data[8:10]))
			return width, height, width > 0 && height > 0
		}
	case "qoi":
		if len(data) >= 14 && string(data[:4]) == "qoif" {
			width := int(binary.BigEndian.Uint32(data[4:8]))
			height := int(binary.BigEndian.Uint32(data[8:12]))
			return width, height, width > 0 && height > 0
		}
	case "ff", "farbfeld":
		if len(data) >= 16 && string(data[:8]) == "farbfeld" {
			width := int(binary.BigEndian.Uint32(data[8:12]))
			height := int(binary.BigEndian.Uint32(data[12:16]))
			return width, height, width > 0 && height > 0
		}
	}
	if strings.HasPrefix(contentType, "image/") {
		return parseImageDimensions(data, extension, contentType)
	}
	return 0, 0, false
}

func appendUniqueString(values []string, value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return values
	}
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}
