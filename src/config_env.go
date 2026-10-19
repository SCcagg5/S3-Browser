package main

import (
	"os"
	"path/filepath"
	"strings"
)

// lookupConfigEnvironment reads one environment variable. The configuration
// file names each variable with an `_env` attribute. This file is the only
// place of the program that reads the environment (the CI checks it).
func lookupConfigEnvironment(name string) (string, bool) {
	return os.LookupEnv(name)
}

// resolveConfigPath makes a relative path start at the directory of the
// configuration file.
func resolveConfigPath(name, baseDir string) string {
	if !filepath.IsAbs(name) {
		name = filepath.Join(baseDir, name)
	}
	return filepath.Clean(name)
}

// resolveValueSource reads the value of a key that can have the forms
// `<name>`, `<name>_env` and `<name>_file`. The forms parameter tells which
// forms the key accepts. Exactly one form can be in the block. A variable that
// does not exist, an empty value, or a file that the server cannot read is an
// error. The value of a file has no last line end. The function does not
// change the value in other ways.
func resolveValueSource(block hclBlock, path, name, baseDir string, forms keyForms) (string, bool, error) {
	direct, directOK := block.stringAttr(name)
	envName, envOK := block.stringAttr(name + "_env")
	fileName, fileOK := block.stringAttr(name + "_file")
	count := 0
	for _, present := range []bool{directOK, envOK, fileOK} {
		if present {
			count++
		}
	}
	if count == 0 {
		return "", false, nil
	}
	if count > 1 {
		return "", false, block.errorf("%s.%s: give only one of %s, %s_env and %s_file", path, name, name, name, name)
	}
	switch {
	case directOK:
		if forms&formValue == 0 {
			return "", false, block.errorf("%s.%s is a secret: use %s_env or %s_file, not the value in clear text", path, name, name, name)
		}
		if direct == "" {
			return "", false, block.errorf("%s.%s is empty", path, name)
		}
		return direct, true, nil
	case envOK:
		if envName == "" {
			return "", false, block.errorf("%s.%s_env is empty", path, name)
		}
		value, exists := lookupConfigEnvironment(envName)
		if !exists {
			return "", false, block.errorf("%s.%s_env: the environment variable %q does not exist", path, name, envName)
		}
		if value == "" {
			return "", false, block.errorf("%s.%s_env: the environment variable %q is empty", path, name, envName)
		}
		return value, true, nil
	default:
		if fileName == "" {
			return "", false, block.errorf("%s.%s_file is empty", path, name)
		}
		cleaned := resolveConfigPath(fileName, baseDir)
		data, err := readBoundedFile(cleaned, maxSecretFileBytes)
		if err != nil {
			return "", false, block.errorf("%s.%s_file: cannot read %q: %v", path, name, cleaned, err)
		}
		value := strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r")
		if value == "" {
			return "", false, block.errorf("%s.%s_file: the file %q is empty", path, name, cleaned)
		}
		return value, true, nil
	}
}
