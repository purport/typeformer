//@ts-check

import { ProcessOutput, ProcessPromise } from "zx";

// Tremendously terrible hack to make xz print only the commands and not their outputs.
// Please, look away.
// Soon: https://github.com/google/zx/issues/306
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
Object.defineProperty(ProcessPromise.prototype, "_run", {
    configurable: true,
    enumerable: true,
    get: function () {
        return this.__run;
    },
    set: function (run) {
        this.__run = run;

        /** @type { boolean } */
        let _quiet = this._quiet;

        Object.defineProperty(this, "_quiet", {
            configurable: true,
            enumerable: true,
            get: function () {
                if (_quiet) {
                    //
                    return true;
                }

                if (this.__hideOutput ?? defaultHideOutput) {
                    _quiet = true;
                }

                return false;
            },
            set: function (quiet) {
                _quiet = quiet;
            },
        });
    },
});

let defaultHideOutput = false;

/**
 * Sets the default output setting for zx processes.
 * @param {boolean} hideOutput
 */
export function setHideOutput(hideOutput) {
    defaultHideOutput = hideOutput;
}

/**
 * Hides stdout and stderr.
 * @param {ProcessPromise<ProcessOutput>} p
 * @returns {ProcessPromise<ProcessOutput>}
 */
export function hideOutput(p) {
    /** @type {any} */ (p).__hideOutput = true;
    return p;
}

/**
 * Shows stdout and stderr.
 * @param {ProcessPromise<ProcessOutput>} p
 * @returns {ProcessPromise<ProcessOutput>}
 */
export function showOutput(p) {
    /** @type {any} */ (p).__hideOutput = false;
    return p;
}
