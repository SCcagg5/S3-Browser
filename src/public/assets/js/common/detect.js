/* Shared file-type and syntax detection. No runtime dependency. */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});

  function fileName(value = '') {
    return String(value || '').split('/').pop() || '';
  }

  function extOf(value = '') {
    const name = fileName(value).toLowerCase();
    const dot = name.lastIndexOf('.');
    return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : '';
  }

  const EXT_TO_LANG = {
    sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash', fish: 'bash', envrc: 'bash',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
    json: 'json', json5: 'json', hjson: 'json', geojson: 'json', ipynb: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', hcl: 'terraform', tf: 'terraform', tfvars: 'terraform',
    html: 'xml', htm: 'xml', xhtml: 'xml', vue: 'xml', svelte: 'xml', xml: 'xml', svg: 'xml',
    css: 'css', scss: 'scss', sass: 'sass', less: 'less',
    ini: 'ini', conf: 'ini', cfg: 'ini', properties: 'ini', cnf: 'ini',
    md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkd: 'markdown', rmd: 'markdown', adoc: 'asciidoc', asciidoc: 'asciidoc',
    txt: 'plaintext', log: 'plaintext', out: 'plaintext', diff: 'diff', patch: 'diff',
    sql: 'sql', gql: 'graphql', graphql: 'graphql', proto: 'protobuf', thrift: 'thrift',
    mk: 'makefile', nginx: 'nginx',
    java: 'java', kt: 'kotlin', kts: 'kotlin', groovy: 'groovy', scala: 'scala',
    c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp', inl: 'cpp',
    m: 'objectivec', mm: 'objectivec', cs: 'csharp',
    go: 'go', mod: 'go', sum: 'plaintext', work: 'go', rs: 'rust', swift: 'swift',
    py: 'python', pyw: 'python', pyi: 'python', rb: 'ruby', php: 'php', phtml: 'php',
    pl: 'perl', pm: 'perl', lua: 'lua', r: 'r', dart: 'dart', zig: 'zig', cue: 'cue', nix: 'nix',
    bat: 'dos', cmd: 'dos', vb: 'vbnet', vbs: 'vbscript', fs: 'fsharp', fsx: 'fsharp',
    hs: 'haskell', ml: 'ocaml', mli: 'ocaml', pas: 'pascal', pp: 'pascal',
    mustache: 'xml', hbs: 'xml', handlebars: 'xml', ejs: 'xml', njk: 'xml', twig: 'xml', jinja: 'xml',
    lock: 'plaintext'
  };

  const EXACT_CODE_NAMES = new Map([
    ['dockerfile', 'dockerfile'], ['containerfile', 'dockerfile'], ['makefile', 'makefile'], ['gnumakefile', 'makefile'],
    ['jenkinsfile', 'groovy'], ['vagrantfile', 'ruby'], ['procfile', 'plaintext'], ['gemfile', 'ruby'],
    ['rakefile', 'ruby'], ['guardfile', 'ruby'], ['justfile', 'makefile'], ['caddyfile', 'plaintext'],
    ['taskfile', 'yaml'], ['earthfile', 'dockerfile'], ['brewfile', 'ruby'], ['podfile', 'ruby'],
    ['cartfile', 'plaintext'], ['aptfile', 'plaintext'], ['codeowners', 'plaintext'], ['owners', 'plaintext'],
    ['maintainers', 'plaintext'], ['version', 'plaintext'], ['release', 'plaintext'], ['todo', 'plaintext'],
    ['build', 'plaintext'], ['workspace', 'plaintext'], ['build.bazel', 'plaintext'], ['workspace.bazel', 'plaintext'],
    ['go.mod', 'go'], ['go.sum', 'plaintext'], ['go.work', 'go'], ['cargo.lock', 'toml'], ['package-lock.json', 'json'],
    ['pnpm-lock.yaml', 'yaml'], ['yarn.lock', 'plaintext'], ['composer.lock', 'json'], ['poetry.lock', 'toml'],
    ['pipfile', 'toml'], ['pipfile.lock', 'json'], ['requirements.txt', 'plaintext']
  ]);

  const DOTFILE_LANG = new Map([
    ['.env', 'ini'], ['.envrc', 'bash'], ['.gitignore', 'plaintext'], ['.gitattributes', 'plaintext'],
    ['.gitmodules', 'ini'], ['.dockerignore', 'plaintext'], ['.npmignore', 'plaintext'], ['.npmrc', 'ini'],
    ['.yarnrc', 'yaml'], ['.editorconfig', 'ini'], ['.eslintignore', 'plaintext'], ['.prettierignore', 'plaintext'],
    ['.prettierrc', 'json'], ['.eslintrc', 'json'], ['.stylelintrc', 'json'], ['.babelrc', 'json'],
    ['.browserslistrc', 'plaintext'], ['.curlrc', 'plaintext'], ['.wgetrc', 'plaintext'], ['.inputrc', 'bash'],
    ['.profile', 'bash'], ['.bashrc', 'bash'], ['.bash_profile', 'bash'], ['.zshrc', 'bash'], ['.zprofile', 'bash'],
    ['.tool-versions', 'plaintext'], ['.nvmrc', 'plaintext'], ['.node-version', 'plaintext'],
    ['.python-version', 'plaintext'], ['.ruby-version', 'plaintext'], ['.go-version', 'plaintext'],
    ['.java-version', 'plaintext'], ['.sdkmanrc', 'ini'], ['.gitkeep', 'plaintext'], ['.keep', 'plaintext'],
    ['.nojekyll', 'plaintext']
  ]);

  const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
  const CONVERT_IMAGE_EXT = new Set(['tif', 'tiff', 'heic', 'heif', 'jxl', 'jp2', 'j2k', 'jpf', 'jpx', 'jpc', 'psd', 'psb', 'tga', 'exr', 'hdr', 'rgbe', 'dds', 'pcx', 'pnm', 'ppm', 'pgm', 'pbm', 'pam', 'sgi', 'rgb', 'rgba', 'bw', 'qoi', 'ff', 'farbfeld', 'fits', 'fit', 'fts']);
  const RAW_IMAGE_EXT = new Set(['raf', 'raw', 'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'rw2', 'pef', 'x3f', 'erf', 'mef', 'mos', 'kdc', 'dcr', 'mrw', 'rwl', 'iiq', '3fr', 'fff']);
  const VIDEO_EXT = new Set(['mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v', 'mpg', 'mpeg', 'flv', 'f4v', '3gp', '3g2', 'wmv', 'asf', 'ogv', 'mts', 'm2ts', 'ts', 'vob', 'mxf', 'dv', 'dvr-ms', 'm2v', 'rm', 'rmvb', 'nut', 'y4m']);
  const AUDIO_EXT = new Set(['mp3', 'flac', 'wav', 'wave', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'aiff', 'aif', 'alac', 'wma', 'amr', 'midi', 'mid', 'ape', 'wv', 'tta', 'ac3', 'eac3', 'dts', 'mka', 'au', 'caf']);
  const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'xz', 'txz', 'zst', 'jar', 'war']);
  const TABULAR_EXT = new Set(['csv', 'tsv', 'tab', 'psv', 'jsonl', 'ndjson']);
  const JSON_EXT = new Set(['json', 'geojson']);
  const SQLITE_EXT = new Set(['sqlite', 'sqlite3', 'db', 'db3', 's3db', 'sl3']);
  const WORD_PREVIEW_EXT = new Set(['docx', 'dotx', 'docm', 'dotm']);
  const WORD_UNAVAILABLE_EXT = new Set(['doc', 'dot', 'odt', 'rtf', 'pages']);
  const SPREADSHEET_PREVIEW_EXT = new Set(['xls', 'xlsx', 'xlsm']);
  const SHEET_EXT = new Set(['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'ods', 'numbers']);
  const SLIDE_EXT = new Set(['ppt', 'pptx', 'pps', 'ppsx', 'odp', 'key']);
  const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd', 'rmd']);
  const VIDEO_QUALITY_PATTERN = /(^|[._\s-])((?:[1-9]\d{2,3})p|(?:[1-9]\d{2,3})x(?:[1-9]\d{2,3})|4k|uhd|qhd|fhd|hd|sd)(?=$|[._\s-])/ig;

  function videoQualityHeight(token) {
    const value = String(token || '').toLowerCase();
    const vertical = value.match(/^(\d{3,4})p$/);
    if (vertical) return Number(vertical[1]);
    const dimensions = value.match(/^\d{3,4}x(\d{3,4})$/);
    if (dimensions) return Number(dimensions[1]);
    return ({ '4k': 2160, uhd: 2160, qhd: 1440, fhd: 1080, hd: 720, sd: 480 })[value] || 0;
  }

  function videoVariantDescriptor(value = '') {
    const name = fileName(value);
    const extension = extOf(name);
    const stem = extension ? name.slice(0, -(extension.length + 1)) : name;
    VIDEO_QUALITY_PATTERN.lastIndex = 0;
    let match = null;
    let candidate;
    while ((candidate = VIDEO_QUALITY_PATTERN.exec(stem)) !== null) match = candidate;

    let baseStem = stem;
    let token = '';
    let height = 0;
    if (match) {
      token = match[2];
      height = videoQualityHeight(token);
      const tokenStart = match.index + match[1].length;
      baseStem = `${stem.slice(0, tokenStart)}${stem.slice(tokenStart + token.length)}`
        .replace(/^[._\s-]+|[._\s-]+$/g, '')
        .replace(/([._\s-])[._\s-]+/g, '$1');
    }
    if (!baseStem) baseStem = stem;

    return {
      name,
      extension,
      stem,
      baseStem,
      group: baseStem.toLowerCase().replace(/[._\s-]+/g, ' ').trim(),
      token,
      height,
      label: height > 0 ? `${height}p` : (token ? token.toUpperCase() : 'Original'),
      original: !token
    };
  }

  function codeLanguageForName(value) {
    const name = fileName(value);
    const lower = name.toLowerCase();
    if (EXACT_CODE_NAMES.has(lower)) return EXACT_CODE_NAMES.get(lower);
    if (DOTFILE_LANG.has(lower)) return DOTFILE_LANG.get(lower);
    if (/^(dockerfile|containerfile|jenkinsfile)(\..+)?$/i.test(name)) {
      return /^jenkinsfile/i.test(name) ? 'groovy' : 'dockerfile';
    }
    if (/^\.env(?:\..+)?$/i.test(name)) return 'ini';
    if (/^\.(?:eslintrc|prettierrc|stylelintrc|babelrc)(?:\..+)?$/i.test(name)) {
      const extension = extOf(name);
      return EXT_TO_LANG[extension] || 'json';
    }
    if (/^(?:taskfile|compose|docker-compose)(?:\..+)?\.ya?ml$/i.test(name)) return 'yaml';
    if (/^(?:makefile|gnumakefile)(\..+)?$/i.test(name)) return 'makefile';
    const extension = extOf(name);
    return EXT_TO_LANG[extension] || '';
  }

  function resolveLang(key, mime = '') {
    const fromName = codeLanguageForName(key);
    if (fromName) return fromName;
    const value = String(mime || '').toLowerCase();
    if (/json/.test(value)) return 'json';
    if (/ya?ml/.test(value)) return 'yaml';
    if (/javascript|ecmascript/.test(value)) return 'javascript';
    if (/typescript/.test(value)) return 'typescript';
    if (/html|xml|svg/.test(value)) return 'xml';
    if (/css/.test(value)) return 'css';
    if (/shell|bash/.test(value)) return 'bash';
    if (/markdown/.test(value)) return 'markdown';
    return 'plaintext';
  }

  function isTextualMime(mime = '') {
    return /^text\//i.test(mime) || /(json|xml|yaml|toml|javascript|typescript|shell|graphql|sql|protobuf)/i.test(mime);
  }

  function iconForType(type) {
    const icons = {
      image: 'file-image-outline',
      'raw-image': 'file-image-outline',
      'image-convert': 'file-image-outline',
      video: 'file-video-outline',
      audio: 'file-music-outline',
      pdf: 'file-pdf-box',
      markdown: 'file-document-outline',
      code: 'file-code-outline',
      archive: 'zip-box',
      tabular: 'file-table-outline',
      parquet: 'table-large',
      spreadsheet: 'file-excel-outline',
      json: 'code-json',
      sqlite: 'database-search-outline',
      word: 'file-word-outline',
      'sheet-unavailable': 'file-excel-outline',
      'slide-unavailable': 'file-powerpoint-outline',
      'word-unavailable': 'file-word-outline'
    };
    return icons[String(type || '')] || 'file-outline';
  }

  function resolveType(key, mime = '') {
    const extension = extOf(key);
    const contentType = String(mime || '').toLowerCase();

    // Binary office/container formats must be classified before generic MIME
    // fallbacks so a DOCX never reaches the text renderer as ZIP bytes.
    if (WORD_PREVIEW_EXT.has(extension) || /wordprocessingml/i.test(contentType)) return 'word';
    if (WORD_UNAVAILABLE_EXT.has(extension) || /(msword|opendocument\.text|rtf)/i.test(contentType)) return 'word-unavailable';
    if (SPREADSHEET_PREVIEW_EXT.has(extension)) return 'spreadsheet';
    if (SHEET_EXT.has(extension) || /opendocument\.spreadsheet/i.test(contentType)) return 'sheet-unavailable';
    if (/(spreadsheetml|ms-excel)/i.test(contentType)) return 'spreadsheet';
    if (SLIDE_EXT.has(extension) || /(presentationml|ms-powerpoint|opendocument\.presentation)/i.test(contentType)) return 'slide-unavailable';
    if (extension === 'parquet' || /parquet/i.test(contentType)) return 'parquet';
    if (TABULAR_EXT.has(extension) || /(?:text\/(?:csv|tsv)|tab-separated-values|ndjson|json-seq)/i.test(contentType)) return 'tabular';
    if (JSON_EXT.has(extension) || /(?:application|text)\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) return 'json';
    if (SQLITE_EXT.has(extension) || /(?:application\/(?:x-)?sqlite3?|application\/vnd\.sqlite3)/i.test(contentType)) return 'sqlite';
    if (RAW_IMAGE_EXT.has(extension)) return 'raw-image';
    if (CONVERT_IMAGE_EXT.has(extension)) return 'image-convert';
    if (IMAGE_EXT.has(extension) || /^image\//i.test(contentType)) return 'image';
    if (VIDEO_EXT.has(extension) || /^video\//i.test(contentType)) return 'video';
    if (AUDIO_EXT.has(extension) || /^audio\//i.test(contentType)) return 'audio';
    if (extension === 'pdf' || /application\/pdf/i.test(contentType)) return 'pdf';
    if (MARKDOWN_EXT.has(extension) || /markdown/i.test(contentType)) return 'markdown';
    if (ARCHIVE_EXT.has(extension) || /(zip|rar|7z|tar|gzip|bzip|xz|zstd)/i.test(contentType)) return 'archive';
    if (codeLanguageForName(key)) return 'code';
    if (isTextualMime(contentType)) return 'code';
    return 'unknown';
  }

  BB.detect = {
    fileName,
    extOf,
    resolveLang,
    resolveType,
    codeLanguageForName,
    isTextualMime,
    videoVariantDescriptor,
    iconForType,
    EXT_TO_LANG,
    RAW_IMAGE_EXT,
    CONVERT_IMAGE_EXT
  };
})();
