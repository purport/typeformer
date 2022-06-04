/** @type {import('npm-check-updates').RunOptions}*/
module.exports = {
    reject: "zx", // TODO: quiet hack doesn't work in newer versions.
    target: (dependencyName, [{ semver, version, operator, major, minor, patch, release, build }]) => {
        if (dependencyName === "@types/node") return "minor";
        if (major === "0") return "minor";
        return "latest";
    },
};
