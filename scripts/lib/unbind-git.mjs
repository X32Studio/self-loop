// Every git command here names its repository with `-C <dir>`. Variables that bind git to another repository or index
// (set, for example, while a git hook runs) would redirect those commands, so importing this module removes them from
// this process's environment. A command that needs a private index sets GIT_INDEX_FILE for itself (call.mjs).
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_NAMESPACE"])
  delete process.env[key];
