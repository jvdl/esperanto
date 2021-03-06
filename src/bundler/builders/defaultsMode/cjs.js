import packageResult from 'utils/packageResult';
import { req } from 'utils/mappers';

export default function cjs ( bundle, options ) {
	var importBlock = bundle.externalModules.map( x => {
		return `var ${x.name} = ${req(x.id)};`;
	}).join( '\n' );

	if ( importBlock ) {
		bundle.body.prepend( importBlock + '\n\n' );
	}

	var defaultName = bundle.entryModule.identifierReplacements.default;
	if ( defaultName ) {
		bundle.body.append( `\n\nmodule.exports = ${defaultName};` );
	}

	bundle.body.prepend("'use strict';\n\n").trimLines();

	return packageResult( bundle, bundle.body, options, 'toCjs', true );
}
