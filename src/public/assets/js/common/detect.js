/*!
 * BB.detect — Shared detection utilities (ext + MIME) for rendering & syntax
 * Keep this file the single source of truth for preview + app.
 * No external deps. Exposes global: window.BB.detect
 */
(function () {
  const BB = (window.BB = window.BB || {});

  function encodePath(path) {
    path = (path || '').replace(/\/{2,}/g, '/');
    try { if (decodeURI(path) !== path) return path; } catch (e) {}
    const m = {";":"%3B","?":"%3F",":":"%3A","@":"%40","&":"%26","=":"%3D","+":"%2B","$":"%24",",":"%2C","#":"%23"};
    return encodeURI(path).split("").map(ch => m[ch] || ch).join("");
  }
  function extOf(s='') {
    const m = /\.([^.]+)$/.exec((s||'').toLowerCase());
    return m ? m[1] : '';
  }

  const EXT_TO_LANG = {
    sh:'bash', bash:'bash', zsh:'bash', ksh:'bash', fish:'bash',
    ps1:'powershell', psm1:'powershell', psd1:'powershell',
    js:'javascript', mjs:'javascript', cjs:'javascript',
    ts:'typescript', jsx:'jsx', tsx:'tsx',
    json:'json', json5:'json', ndjson:'json', jsonl:'json', hjson:'json',
    yaml:'yaml', yml:'yaml', toml:'toml',
    html:'xml', htm:'xml', xhtml:'xml', vue:'xml', svelte:'xml',
    css:'css', scss:'scss', sass:'sass', less:'less',
    xml:'xml', rss:'xml', atom:'xml', svg:'xml',
    ini:'ini', conf:'ini', cfg:'ini', properties:'ini', env:'ini', dotenv:'ini', editorconfig:'ini',
    md:'markdown', markdown:'markdown', mdown:'markdown', mkd:'markdown', rmd:'markdown',
    gitignore: 'plaintext',
    txt:'plaintext', log:'plaintext', csv:'plaintext', tsv:'plaintext',
    sql:'sql', gql:'graphql', graphql:'graphql',
    dockerfile:'dockerfile', compose:'yaml',
    makefile:'makefile', mk:'makefile', gnumakefile:'makefile',
    nginx:'nginx', proto:'protobuf', thrift:'thrift',
    java:'java', kt:'kotlin', kts:'kotlin', groovy:'groovy', scala:'scala',
    c:'c', h:'c',
    cpp:'cpp', cxx:'cpp', cc:'cpp', hpp:'cpp', hxx:'cpp', inl:'cpp',
    m:'objectivec', mm:'objectivec',
    cs:'csharp',
    go:'go', rs:'rust', swift:'swift',
    py:'python', pyw:'python',
    rb:'ruby',
    php:'php', phtml:'php', inc:'php',
    pl:'perl', pm:'perl', t:'perl',
    lua:'lua', r:'r', dart:'dart',
    prisma:'prisma', zig:'zig', cue:'cue', bicep:'bicep',
    tf:'terraform', tfvars:'terraform', hcl:'terraform',
    kql:'kusto',
    asciidoc:'asciidoc', adoc:'asciidoc',
    bat:'dos', cmd:'dos',
    wasm:'wasm',
    scalahtml:'xml',
    mustache:'xml', hbs:'xml', ejs:'xml', njk:'xml', twig:'xml', jinja:'xml',
    handlebars:'xml',
    hs:'haskell',
    ml:'ocaml', mli:'ocaml',
    pas:'pascal', pp:'pascal',
    vb:'vbnet', vbs:'vbscript',
    fs:'fsharp', fsx:'fsharp',
    ipynb:'json'
  };

  const MIME_TO_LANG = [
    [/shellscript|x-sh|x-bash|x-zsh|x-shellscript/i, 'bash'],
    [/powershell/i, 'powershell'],
    [/typescript/i, 'typescript'],
    [/javascript|ecmascript/i, 'javascript'],
    [/json|ndjson|jsonl/i, 'json'],
    [/yaml|yml/i, 'yaml'],
    [/xml|html|xhtml|svg/i, 'xml'],
    [/css/i, 'css'],
    [/markdown|md/i, 'markdown'],
    [/x-toml|toml/i, 'toml'],
    [/x-ini|ini|config|properties/i, 'ini'],
    [/python/i, 'python'],
    [/ruby/i, 'ruby'],
    [/php/i, 'php'],
    [/java/i, 'java'],
    [/kotlin/i, 'kotlin'],
    [/go/i, 'go'],
    [/rust/i, 'rust'],
    [/c\+\+|x-c\+\+|cpp/i, 'cpp'],
    [/csharp|c\#/i, 'csharp'],
    [/sql|postgresql|mysql|sqlite/i, 'sql'],
    [/graphql/i, 'graphql'],
    [/dockerfile|x-dockerfile/i, 'dockerfile'],
    [/makefile/i, 'makefile'],
    [/nginx/i, 'nginx'],
    [/protobuf/i, 'protobuf'],
    [/thrift/i, 'thrift'],
    [/lua/i, 'lua'],
    [/perl/i, 'perl'],
    [/swift/i, 'swift'],
    [/haskell/i, 'haskell'],
    [/clojure|edn/i, 'clojure'],
    [/elixir/i, 'elixir'],
    [/ocaml/i, 'ocaml'],
    [/pascal|delphi/i, 'pascal'],
    [/vb(net)?|vbs/i, 'vbnet'],
    [/fsharp/i, 'fsharp'],
    [/asciidoc/i, 'asciidoc'],
    [/latex|x-tex/i, 'latex'],
    [/terraform|hcl/i, 'terraform'],
    [/kusto/i, 'kusto'],
    [/dart/i, 'dart'],
    [/r-language|x-r|\/r$/i, 'r'],
    [/text\/plain/i, 'plaintext']
  ];

  const IMG_EXT = ['png','jpg','jpeg','gif','webp','bmp','svg','avif'];
  const VID_EXT = ['mp4','mkv','webm','avi','mov','m4v','mpg','mpeg','flv','3gp','wmv','ogv','mts','m2ts','ts','vob'];
  const AUD_EXT = ['mp3','flac','wav','m4a','aac','ogg','opus','aiff','aif','alac','wma','amr','midi','mid'];
  const ARC_EXT = ['zip','rar','7z','tar','gz','tgz','bz2','tbz','xz','txz','zst'];
  const XLS_EXT = ['xls','xlsx','xlsm','xlsb','xlt','ods','csv','tsv','numbers', 'parquet'];
  const PPT_EXT = ['ppt','pptx','pps','ppsx','odp','key'];

  function isImageExt(e){ return IMG_EXT.includes(e); }
  function isVideoExt(e){ return VID_EXT.includes(e); }
  function isAudioExt(e){ return AUD_EXT.includes(e); }
  function isPdfExt(e){ return e === 'pdf'; }
  function isArchiveExt(e){ return ARC_EXT.includes(e); }
  function isSpreadsheetExt(e){ return XLS_EXT.includes(e); }
  function isPresentationExt(e){ return PPT_EXT.includes(e); }
  function isCodeExt(e){ return !!EXT_TO_LANG[e]; }
  function isMarkdownExt(e){ return ['md','markdown','mdown','mkd','rmd', 'gitignore'].includes(e); }

  function isImageMime(ct){ return /^image\//i.test(ct||''); }
  function isVideoMime(ct){ return /^video\//i.test(ct||''); }
  function isAudioMime(ct){ return /^audio\//i.test(ct||''); }
  function isPdfMime(ct){ return /application\/pdf/i.test(ct||''); }
  function isTextualMime(ct){ return /^text\//i.test(ct||'') || /(json|xml|yaml|toml|javascript|typescript|shellscript)/i.test(ct||''); }
  function isMarkdownMime(ct){ return /markdown|md/i.test(ct||''); }
  function isEmbeddableMime(ct){ return /(pdf|svg|html)/i.test(ct||''); }

  function langFromExt(e){ return EXT_TO_LANG[e] || 'plaintext'; }
  function langFromMime(ct=''){ const lo=(ct||'').toLowerCase(); for (const [rx,lang] of MIME_TO_LANG) if (rx.test(lo)) return lang; return ''; }
  function resolveLang(key, mime){
    const e = extOf(key);
    if (isMarkdownExt(e)) return 'markdown';
    if (EXT_TO_LANG[e]) return EXT_TO_LANG[e];
    const byMime = langFromMime(mime);
    return byMime || 'plaintext';
  }

  function resolveType(key, mime) {
    const e = extOf(key);
    if (isImageExt(e)) return 'image';
    if (isVideoExt(e)) return 'video';
    if (isAudioExt(e)) return 'audio';
    if (isPdfExt(e)) return 'pdf';
    if (isMarkdownExt(e)) return 'markdown';
    if (isSpreadsheetExt(e)) return 'spreadsheet';
    if (isPresentationExt(e)) return 'presentation';
    if (isArchiveExt(e)) return 'archive';
    if (isCodeExt(e)) return 'code';
    if (isImageMime(mime)) return 'image';
    if (isVideoMime(mime)) return 'video';
    if (isAudioMime(mime)) return 'audio';
    if (isPdfMime(mime)) return 'pdf';
    if (isMarkdownMime(mime)) return 'markdown';
    if (isTextualMime(mime)) return 'code';
    if (isEmbeddableMime(mime)) return 'embed';
    return 'download';
  }

  BB.detect = {
    encodePath, extOf,
    EXT_TO_LANG, MIME_TO_LANG,
    isImageExt, isVideoExt, isAudioExt, isPdfExt, isArchiveExt, isSpreadsheetExt, isPresentationExt, isCodeExt, isMarkdownExt,
    isImageMime, isVideoMime, isAudioMime, isPdfMime, isTextualMime, isMarkdownMime, isEmbeddableMime,
    langFromExt, langFromMime, resolveLang, resolveType
  };
})();
