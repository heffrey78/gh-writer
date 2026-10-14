// Fetch what the desktop app runs on for one platform (D9): Node's official binary and GitHub's
// portable git (dugite-native), pinned and checked against the checksums below, into
// dist/runtime/<target>/:
//   node/       node (node.exe on Windows) and Node's LICENSE
//   git/        the portable git, without Git Credential Manager, Git LFS, Perl, gitweb or
//               translations (the app answers git's credential prompts itself, and reads git's
//               messages in English)
//   licenses/   Node's and git's licences, and where git's source is
// Downloads are cached in node_modules/.cache/gh-writer-runtime. For this machine's own target, it
// checks that node and the git run with nothing else on PATH.
// Usage: node scripts/fetch-runtime.ts [target] [--out <dir>]   (targets below; default: this machine's)
//        node scripts/fetch-runtime.ts --versions                 (the pinned versions, as JSON)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { unzipSync } from "fflate";

// Node 26 until it's LTS (late October 2026), then that line. To bump: the version and the four
// checksums from https://nodejs.org/dist/v<version>/SHASUMS256.txt.
const NODE = {
  version: "26.11.1",
  files: {
    "linux-x64": ["node-v26.11.1-linux-x64.tar.xz", "3883bfc73f9a680ca4eab04b196068aaaab1373ffa77d8fc1a4408222495b651"],
    "darwin-arm64": ["node-v26.11.1-darwin-arm64.tar.gz", "d916511b55965e91be7a88e17f88d895b6793ceaba3e6c9b194aefe51c2c65ac"],
    "darwin-x64": ["node-v26.11.1-darwin-x64.tar.gz", "9a8129bd9ab08039793dd1143a7aedee6b5d60ac06592ad938d8bddf36142f3a"],
    "win32-x64": ["node-v26.11.1-win-x64.zip", "97f36a8a9684ff0d3e35758b4610fef5b628a5880e96f2ccc11240e5daf9934e"],
  },
} as const;

// To bump: the release tag, git's version, and each asset's .sha256 from
// https://github.com/desktop/dugite-native/releases (and COPYING's, if it changed).
const GIT = {
  tag: "v2.53.0-4",
  version: "2.53.0",
  files: {
    "linux-x64": ["dugite-native-v2.53.0-4098283-ubuntu-x64.tar.gz", "cca76aa31ad9e835e771ee7f55b73934777fbd8d16757a10d307ba06de860901"],
    "darwin-arm64": ["dugite-native-v2.53.0-4098283-macOS-arm64.tar.gz", "f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe"],
    "darwin-x64": ["dugite-native-v2.53.0-4098283-macOS-x64.tar.gz", "ae6686718aa34f4140424db16b92a47dcffd6d1f312eb8b5f3b267f7404e2680"],
    "win32-x64": ["dugite-native-v2.53.0-4098283-windows-x64.tar.gz", "7b76bc5c32c0d7c5984efdc2a8a32697cf1e8a43bc55176fbf9869c0ee995130"],
  },
  copying: "5b2198d1645f767585e8a88ac0499b04472164c0d2da22e75ecf97ef443ab32e",
} as const;

type Target = keyof typeof NODE.files;
const TARGETS = Object.keys(NODE.files) as Target[];

/** What the app doesn't use, by path within the portable git. */
const UNUSED = {
  // Git Credential Manager (a .NET app with its own runtime), Git LFS, Scalar, and what only Perl and
  // shell scripts, the web viewer or translated messages need.
  unix: [
    /^libexec\/git-core\/(git-credential-manager.*|git-lfs|scalar|NOTICE|uninstall\.sh|createdump|.*\.(dll|dylib|so|json|pdb))$/,
    /^share\/(gitweb|perl5|locale|bash-completion)\//,
    /^bin\/scalar$/,
  ],
  // MinGit: Git Credential Manager and its UI libraries, Git LFS, Scalar. Checked on Windows in #196.
  win32: [
    /^mingw64\/bin\/(git-credential-manager.*|scalar\.exe|gcmcore\.dll|msalruntime\.dll|av_libglesv2\.dll|(lib)?(SkiaSharp|HarfBuzzSharp)\.dll|(Atlassian|Avalonia|GitHub|GitLab|MicroCom|Microsoft|System)\..*\.dll|Avalonia\.dll)$/,
    /^mingw64\/libexec\/git-core\/git-lfs\.exe$/,
    /^mingw64\/doc\/git-credential-manager\//,
    /^mingw64\/share\/locale\//,
  ],
};

const repo = fileURLToPath(new URL("..", import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" }, versions: { type: "boolean" } } });
// --versions: what's pinned, for the release (git's source goes with every release, GPL-2.0).
if (values.versions) {
  console.log(JSON.stringify({ node: NODE.version, git: GIT.version, gitTag: GIT.tag }));
  process.exit(0);
}
const host = `${process.platform}-${process.arch}`;
const target = (positionals[0] ?? host) as Target;
if (!TARGETS.includes(target)) {
  console.error(`No runtime for "${target}": one of ${TARGETS.join(", ")}.`);
  process.exit(1);
}
const out = values.out ?? join(repo, "dist/runtime", target);
const cache = join(repo, "node_modules/.cache/gh-writer-runtime");
const windows = target.startsWith("win32");

/** A file from the cache, or downloaded into it; either way, checked against its checksum. */
async function fetchChecked(url: string, name: string, sha256: string): Promise<string> {
  const file = join(cache, name);
  if (!existsSync(file) || hash(file) !== sha256) {
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    mkdirSync(cache, { recursive: true });
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  const actual = hash(file);
  if (actual !== sha256) {
    rmSync(file);
    throw new Error(`${name} doesn't match its checksum (expected ${sha256}, got ${actual}): not used.`);
  }
  return file;
}

function hash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Unpack a .tar.gz, .tar.xz or .zip into a new temporary folder. */
function unpack(archive: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-writer-runtime-"));
  if (archive.endsWith(".zip")) {
    for (const [path, bytes] of Object.entries(unzipSync(readFileSync(archive)))) {
      if (path.endsWith("/")) continue;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), bytes);
    }
  } else {
    const r = spawnSync("tar", ["-xf", archive, "-C", dir], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`Couldn't unpack ${archive}: ${r.stderr}`);
  }
  return dir;
}

/** Files and symbolic links under `dir` (git's builtins are links to git), by /-separated path. */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => !lstatSync(join(dir, path)).isDirectory())
    .map((path) => path.split("\\").join("/"));
}

/** Bytes on disk, counting each link as the link it is, not what it points to. */
const sizeOf = (file: string) => lstatSync(file).size;

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "node"), { recursive: true });
mkdirSync(join(out, "licenses"), { recursive: true });

// Node: the binary and its licence only (no npm).
{
  const [name, sha256] = NODE.files[target];
  const unpacked = unpack(await fetchChecked(`https://nodejs.org/dist/v${NODE.version}/${name}`, name, sha256));
  const root = join(unpacked, name.replace(/\.(tar\.xz|tar\.gz|zip)$/, ""));
  const binary = windows ? "node.exe" : "node";
  cpSync(join(root, windows ? binary : `bin/${binary}`), join(out, "node", binary));
  if (!windows) chmodSync(join(out, "node", binary), 0o755);
  cpSync(join(root, "LICENSE"), join(out, "licenses/node-LICENSE.txt"));
  rmSync(unpacked, { recursive: true, force: true });
}

// git: everything but what the app doesn't use.
{
  const [name, sha256] = GIT.files[target];
  const unpacked = unpack(await fetchChecked(`https://github.com/desktop/dugite-native/releases/download/${GIT.tag}/${name}`, name, sha256));
  const unused = UNUSED[windows ? "win32" : "unix"];
  let dropped = 0;
  for (const path of filesIn(unpacked)) {
    if (!unused.some((pattern) => pattern.test(path))) continue;
    dropped += sizeOf(join(unpacked, path));
    rmSync(join(unpacked, path));
  }
  // No links: app bundlers copy what they point to, which would make each of the dashed built-ins
  // (git-add → git, and 140 more) a 4 MB copy. git runs its built-ins itself, so those go, as Git for
  // Windows leaves them out, except the ones a transport runs by name (a local clone runs
  // git-upload-pack); those, and git-remote-https, become copies of what they name, and the ftp ones go.
  for (const path of filesIn(unpacked).filter((p) => lstatSync(join(unpacked, p)).isSymbolicLink())) {
    const link = join(unpacked, path);
    const pointsTo = readlinkSync(link);
    rmSync(link);
    if (/\/git-(upload-pack|receive-pack|upload-archive|remote-https)$/.test(path)) cpSync(join(dirname(link), pointsTo), link);
  }
  cpSync(unpacked, join(out, "git"), { recursive: true });
  rmSync(unpacked, { recursive: true, force: true });

  const kept = filesIn(join(out, "git"));
  const size = kept.reduce((sum, path) => sum + sizeOf(join(out, "git", path)), 0);
  const has = (names: RegExp) => kept.filter((path) => names.test(path));
  console.log(`git ${GIT.version} (${GIT.tag}): ${(size / 1e6).toFixed(1)} MB kept, ${(dropped / 1e6).toFixed(1)} MB left out.`);
  // D9: the app answers credential prompts itself (askpass) because MinGit may have no shell, and
  // ssh remotes use the system's ssh. Say what this build has.
  console.log(`  sh: ${has(/(^|\/)(sh|bash)(\.exe)?$/).join(", ") || "none"}; ssh: ${has(/(^|\/)ssh(\.exe)?$/).join(", ") || "none"}`);
}

// Licences, and where git's source is (GPL-2.0, section 3).
{
  const copying = await fetchChecked(`https://raw.githubusercontent.com/git/git/v${GIT.version}/COPYING`, `git-${GIT.version}-COPYING`, GIT.copying);
  cpSync(copying, join(out, "licenses/git-COPYING.txt"));
  writeFileSync(
    join(out, "licenses/git-SOURCE.txt"),
    [
      `gh-writer includes git ${GIT.version}, built by GitHub's dugite-native (${GIT.tag}) and distributed`,
      "under the GNU General Public License, version 2 (git-COPYING.txt).",
      "",
      "Its complete corresponding source is attached to every gh-writer release on GitHub, next to",
      "the installers (https://github.com/heffrey78/gh-writer/releases), and is also available from:",
      `  git: https://github.com/git/git/tree/v${GIT.version}`,
      `  the build that packaged it: https://github.com/desktop/dugite-native/tree/${GIT.tag}`,
      "",
    ].join("\n"),
  );
}

// On this machine's own target: both run with nothing else to find them.
if (target === host) {
  const git = join(out, "git");
  const env = {
    PATH: "",
    HOME: mkdtempSync(join(tmpdir(), "gh-writer-runtime-home-")),
    GIT_EXEC_PATH: windows ? join(git, "mingw64/libexec/git-core") : join(git, "libexec/git-core"),
    GIT_TEMPLATE_DIR: windows ? join(git, "mingw64/share/git-core/templates") : join(git, "share/git-core/templates"),
  };
  const run = (file: string, args: string[]) => {
    const r = spawnSync(file, args, { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${relative(out, file)} ${args.join(" ")} failed: ${r.error?.message ?? r.stderr}`);
    return r.stdout.trim();
  };
  const scratch = mkdtempSync(join(tmpdir(), "gh-writer-runtime-check-"));
  const gitBinary = windows ? join(git, "cmd/git.exe") : join(git, "bin/git");
  console.log(`  ${run(join(out, "node", windows ? "node.exe" : "node"), ["--version"])}, ${run(gitBinary, ["--version"])}`);
  run(gitBinary, ["init", "-q", join(scratch, "a")]);
  run(gitBinary, ["-C", join(scratch, "a"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "Check"]);
  run(gitBinary, ["clone", "-q", join(scratch, "a"), join(scratch, "b")]);
  rmSync(scratch, { recursive: true, force: true });
  rmSync(env.HOME, { recursive: true, force: true });
}
console.log(`Fetched the ${target} runtime into ${out}`);
