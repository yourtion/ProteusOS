"""Extract a verified experiment backup into a new directory with bounded resources."""
import pathlib
import sys
import tarfile

archive, destination = map(pathlib.Path, sys.argv[1:])
with tarfile.open(archive, 'r:gz') as bundle:
    members = bundle.getmembers()
    if len(members) > 50000 or sum(m.size for m in members) > 512 * 1024 * 1024:
        raise ValueError('archive exceeds extraction limits')
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if (path.is_absolute() or '..' in path.parts or '\\' in member.name
                or not (member.isfile() or member.isdir())):
            raise ValueError('unsafe archive member: ' + member.name)
    bundle.extractall(destination, members=members, filter='data')
