import gatherImports from './gatherImports';
import getExportNames from './getExportNames';
import traverseAst from 'utils/ast/traverse';

export default function transformBody ( mod, body, options ) {
	var importedBindings,
		identifierReplacements,
		exportNames = [],
		alreadyExported = {},
		shouldExportEarly = {},
		earlyExports,
		lateExports;

	[ importedBindings, identifierReplacements ] = gatherImports( mod.imports, mod.getName );
	exportNames = getExportNames( mod.exports );

	traverseAst( mod.ast, body, identifierReplacements, exportNames, alreadyExported );

	// Remove import statements from the body of the module
	mod.imports.forEach( x => {
		if ( x.passthrough ) {
			// this is an `export { foo } from './bar'` statement -
			// it will be dealt with in the next section
			return;
		}

		body.remove( x.start, x.next );
	});

	// Remove export statements (but keep declarations)
	mod.exports.forEach( x => {
		switch ( x.type ) {
			case 'varDeclaration': // export var answer = 42;
				body.remove( x.start, x.valueStart );
				return;

			case 'namedFunction':
			case 'namedClass':
				if ( x.default ) {
					// export default function answer () { return 42; }
					body.remove( x.start, x.valueStart );
					body.insert( x.end, `\nexports['default'] = ${x.name};` );
				} else {
					// export function answer () { return 42; }
					shouldExportEarly[ x.name ] = true; // TODO what about `function foo () {}; export { foo }`?
					body.remove( x.start, x.valueStart );
				}
				return;

			case 'anonFunction':   // export default function () {}
			case 'anonClass':      // export default class () {}
			case 'expression':     // export default 40 + 2;
				body.replace( x.start, x.valueStart, 'exports[\'default\'] = ' );
				return;

			case 'named':          // export { foo, bar };
				body.remove( x.start, x.next );
				break;

			default:
				throw new Error( 'Unknown export type: ' + x.type );
		}
	});

	// Append export block (this is the same for all module types, unlike imports)
	earlyExports = [];
	lateExports = [];

	Object.keys( exportNames ).forEach( name => {
		var exportAs, chain;

		exportAs = exportNames[ name ];

		if ( chain = importedBindings[ name ] ) {
			// special case - a binding from another module
			earlyExports.push( `Object.defineProperty(exports, '${exportAs}', { get: function () { return ${chain}; }});` );
		} else if ( shouldExportEarly[ name ] ) {
			earlyExports.push( `exports.${exportAs} = ${name};` );
		} else if ( !alreadyExported[ name ] ) {
			lateExports.push( `exports.${exportAs} = ${name};` );
		}
	});

	if ( lateExports.length ) {
		body.trim().append( '\n\n' + lateExports.join( '\n' ) );
	}

	// Prepend require() statements
	if ( options.header ) {
		body.prepend( options.header + '\n\n' );
	}

	// Function exports should be exported immediately after 'use strict'
	if ( earlyExports.length ) {
		body.trim().prepend( earlyExports.join( '\n' ) + '\n\n' );
	}

	body.trim().indent({
		exclude: mod.ast._templateLiteralRanges
	}).prepend( options.intro ).trim().append( options.outro );
}
