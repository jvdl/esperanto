import packageResult from 'utils/packageResult';

export default function concat ( bundle, options ) {
	var intro, outro, indent;

	// This bundle must be self-contained - no imports or exports
	if ( bundle.externalModules.length || bundle.entryModule.exports.length ) {
		throw new Error( `bundle.concat() can only be used with bundles that have no imports/exports (imports: [${bundle.externalModules.map(x=>x.id).join(', ')}], exports: [${bundle.entryModule.exports.join(', ')}])` );
	}

	// TODO test these options
	intro = 'intro' in options ? options.intro : `(function () { 'use strict';\n\n`;
	outro = 'outro' in options ? options.outro : '\n\n})();';

	if ( !( 'indent' in options ) || options.indent === true ) {
		indent = bundle.body.getIndentString();
	} else {
		indent = options.indent || '';
	}

	bundle.body.trimLines().indent( indent ).prepend( intro ).append( outro );

	return packageResult( bundle, bundle.body, options, 'toString', true );
}
