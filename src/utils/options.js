/**
 * Get the default options for tests.
 * @return {Object}
 */
const getDefaultTestOptions = () => {
  return {
    // flag tests as a dry run
    dry: true
  };
};

/**
 * Get the default options for Node.toSource.
 * @return {Object}
 */
const getDefaultSourceOptions = () => {
  return {
    // match ESLint rules
    arrayBracketSpacing: false,
    arrowParensAlways: true,
    objectCurlySpacing: false,
    quote: 'single',
    trailingComma: false,

    // whitespace/formatting
    reuseWhitespace: true,
    tabWidth: 2,
    useTabs: false,
    wrapColumn: 120
  };
};

module.exports = {getDefaultTestOptions, getDefaultSourceOptions};
