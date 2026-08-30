from __future__ import annotations

import io
import json
import os
import re
import tarfile
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


NPM_REGISTRY = os.environ.get("BNH_NPM_REGISTRY", "https://registry.npmjs.org")


def parse_semver(v: str) -> Optional[Tuple[int, int, int]]:
    clean = v.strip().lstrip("=v")
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", clean)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def fetch_package_metadata(package_name: str, registry: str = NPM_REGISTRY) -> Dict[str, Any]:
    encoded = urllib.parse.quote(package_name, safe="@")
    url = f"{registry.rstrip('/')}/{encoded}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def resolve_version(metadata: Dict[str, Any], range_spec: str = "latest") -> Tuple[str, Dict[str, Any]]:
    if range_spec == "latest" and "dist-tags" in metadata and "latest" in metadata["dist-tags"]:
        latest = metadata["dist-tags"]["latest"]
        return latest, metadata["versions"][latest]

    versions = metadata.get("versions", {})
    if range_spec in versions:
        return range_spec, versions[range_spec]

    # Simple latest fallback
    sorted_versions = sorted(
        [v for v in versions.keys() if parse_semver(v)],
        key=lambda v: parse_semver(v) or (0, 0, 0),
        reverse=True,
    )
    for v in sorted_versions:
        # If range is wildcard or matches
        if range_spec in ("*", "latest", ""):
            return v, versions[v]
        if range_spec.startswith("^"):
            target = parse_semver(range_spec[1:])
            cand = parse_semver(v)
            if target and cand and cand[0] == target[0] and cand >= target:
                return v, versions[v]
        if range_spec.startswith("~"):
            target = parse_semver(range_spec[1:])
            cand = parse_semver(v)
            if target and cand and cand[0] == target[0] and cand[1] == target[1] and cand >= target:
                return v, versions[v]

    if sorted_versions:
        top = sorted_versions[0]
        return top, versions[top]

    raise ValueError(f"No matching version found for {metadata.get('name')}@{range_spec}")


def download_tarball(tarball_url: str) -> bytes:
    req = urllib.request.Request(tarball_url)
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.read()


def stage_npm_package(
    package_spec: str,
    target_dir: Path,
    cache_dir: Optional[Path] = None,
    registry: str = NPM_REGISTRY,
) -> Dict[str, Any]:
    """Download and extract an npm package into target_dir/node_modules/<name>."""
    if "@" in package_spec and not package_spec.startswith("@"):
        name, range_spec = package_spec.split("@", 1)
    elif package_spec.startswith("@") and package_spec.count("@") > 1:
        name, range_spec = package_spec.rsplit("@", 1)
    else:
        name, range_spec = package_spec, "latest"

    target_node_modules = target_dir / "node_modules"
    target_node_modules.mkdir(parents=True, exist_ok=True)

    metadata = fetch_package_metadata(name, registry=registry)
    version, version_doc = resolve_version(metadata, range_spec)
    tarball_url = version_doc.get("dist", {}).get("tarball")
    if not tarball_url:
        raise ValueError(f"Missing tarball URL for {name}@{version}")

    tarball_bytes: bytes
    if cache_dir:
        cache_dir.mkdir(parents=True, exist_ok=True)
        safe_name = name.replace("/", "_")
        cache_file = cache_dir / f"{safe_name}-{version}.tgz"
        if cache_file.exists():
            tarball_bytes = cache_file.read_bytes()
        else:
            tarball_bytes = download_tarball(tarball_url)
            cache_file.write_bytes(tarball_bytes)
    else:
        tarball_bytes = download_tarball(tarball_url)

    pkg_dir = target_node_modules / name
    pkg_dir.mkdir(parents=True, exist_ok=True)

    # Extract tarball, stripping package/ prefix
    with tarfile.open(fileobj=io.BytesIO(tarball_bytes), mode="r:gz") as tar:
        for member in tar.getmembers():
            rel_path = member.name
            if rel_path.startswith("package/"):
                rel_path = rel_path[len("package/") :]
            elif rel_path == "package":
                continue
            if not rel_path:
                continue

            dest_path = pkg_dir / rel_path
            if member.isdir():
                dest_path.mkdir(parents=True, exist_ok=True)
            elif member.isreg():
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                fileobj = tar.extractfile(member)
                if fileobj:
                    dest_path.write_bytes(fileobj.read())

    return {
        "name": name,
        "version": version,
        "path": str(pkg_dir),
        "dependencies": version_doc.get("dependencies", {}),
    }
