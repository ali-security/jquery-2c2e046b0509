/* Run the jQuery QUnit browser suite (test/index.html) in headless Chrome
 * and print per-test results plus a passed/failed/total summary.
 * Usage: node .github/qunit/run-browser-tests.js http://127.0.0.1:8000/test/index.html
 * Requires Node 18 and puppeteer-core (resolved via NODE_PATH).
 */
"use strict";

var fs = require( "fs" );
var childProcess = require( "child_process" );
var puppeteer = require( "puppeteer-core" );

var URL = process.argv[ 2 ] || "http://127.0.0.1:8000/test/index.html";
var POLL_MS = 1000;
var PROGRESS_MS = 30 * 1000;
var TIMEOUT_MS = 25 * 60 * 1000;
var MAX_DETAIL = 300;

function resolveChrome() {
	if ( process.env.CHROME_BIN ) {
		return process.env.CHROME_BIN;
	}
	var candidates = [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium-browser"
	];
	for ( var i = 0; i < candidates.length; i++ ) {
		if ( fs.existsSync( candidates[ i ] ) ) {
			return candidates[ i ];
		}
	}
	try {
		var found = childProcess.execSync( "which google-chrome", { encoding: "utf8" } ).trim();
		if ( found ) {
			return found;
		}
	} catch ( e ) {}
	throw new Error( "Could not find a Chrome binary; set CHROME_BIN" );
}

function short( text ) {
	text = String( text == null ? "" : text ).replace( /\s+/g, " " ).trim();
	return text.length > MAX_DETAIL ? text.slice( 0, MAX_DETAIL ) + "..." : text;
}

function sleep( ms ) {
	return new Promise( function( resolve ) {
		setTimeout( resolve, ms );
	} );
}

// Runs in the page: scrape every top-level QUnit test entry.
function scrapeTests() {
	var items = document.querySelectorAll( "#qunit-tests > li" );
	return Array.prototype.map.call( items, function( li ) {
		function text( el ) {
			return el ? el.textContent : "";
		}
		var cls = li.className || "";
		var status = /\bfail\b/.test( cls ) ? "fail" :
			/\bpass\b/.test( cls ) ? "pass" : "incomplete";
		var failures = [];
		if ( status === "fail" ) {
			var asserts = li.querySelectorAll( "ol.qunit-assert-list > li.fail" );
			Array.prototype.forEach.call( asserts, function( a ) {
				var msg = a.querySelector( ".test-message" );
				failures.push( {
					message: msg ? msg.textContent : a.textContent,
					expected: text( a.querySelector( ".test-expected td" ) ),
					actual: text( a.querySelector( ".test-actual td" ) )
				} );
			} );
		}
		return {
			status: status,
			module: text( li.querySelector( ".module-name" ) ),
			name: text( li.querySelector( ".test-name" ) ),
			counts: text( li.querySelector( ".counts" ) ),
			failures: failures
		};
	} );
}

function report( tests, resultText ) {
	var passed = 0, failed = 0, modules = {}, order = [];

	tests.forEach( function( t ) {
		if ( t.status === "incomplete" ) {
			return;
		}
		var label = ( t.status === "pass" ? "PASS " : "FAIL " ) +
			( t.module || "(no module)" ) + " :: " + t.name + " " + t.counts;
		console.log( label );
		t.failures.forEach( function( f ) {
			console.log( "    - " + short( f.message ) );
			if ( f.expected ) {
				console.log( "      expected: " + short( f.expected ) );
			}
			if ( f.actual ) {
				console.log( "      actual:   " + short( f.actual ) );
			}
		} );

		var mod = t.module || "(no module)";
		if ( !modules[ mod ] ) {
			modules[ mod ] = { passed: 0, failed: 0 };
			order.push( mod );
		}
		if ( t.status === "pass" ) {
			passed++;
			modules[ mod ].passed++;
		} else {
			failed++;
			modules[ mod ].failed++;
		}
	} );

	console.log( "" );
	console.log( "Per-module summary:" );
	order.forEach( function( mod ) {
		console.log( "  " + mod + ": " + modules[ mod ].passed + " passed, " +
			modules[ mod ].failed + " failed" );
	} );

	var total = passed + failed;
	console.log( "" );
	console.log( "QUnit summary: " + passed + " tests passed, " + failed +
		" tests failed, " + total + " tests total" );
	console.log( short( resultText ) );
	return { passed: passed, failed: failed, total: total };
}

async function main() {
	var executablePath = resolveChrome();
	console.log( "Using Chrome at " + executablePath );
	console.log( "Opening " + URL );

	var browser = await puppeteer.launch( {
		executablePath: executablePath,
		headless: "new",
		args: [ "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage" ],
		defaultViewport: { width: 1280, height: 1024 }
	} );

	var exitCode = 1;
	try {
		var page = await browser.newPage();
		page.on( "pageerror", function( err ) {
			console.log( "[page] pageerror: " + short( err && err.message ? err.message : err ) );
		} );
		page.on( "console", function( msg ) {
			if ( msg.type() === "error" ) {
				console.log( "[page] console.error: " + short( msg.text() ) );
			}
		} );

		await page.goto( URL, { waitUntil: "load", timeout: 120000 } );

		var started = Date.now();
		var lastProgress = started;
		var done = false;
		var resultText = "";

		while ( Date.now() - started < TIMEOUT_MS ) {
			resultText = await page.evaluate( function() {
				var el = document.getElementById( "qunit-testresult" );
				return el ? el.textContent : "";
			} );
			if ( /Tests completed in/.test( resultText ) ) {
				done = true;
				break;
			}
			if ( Date.now() - lastProgress >= PROGRESS_MS ) {
				lastProgress = Date.now();
				var count = await page.evaluate( function() {
					return document.querySelectorAll( "#qunit-tests > li" ).length;
				} );
				console.log( "[progress] " + Math.round( ( lastProgress - started ) / 1000 ) +
					"s elapsed, " + count + " tests started so far" );
			}
			await sleep( POLL_MS );
		}

		var tests = await page.evaluate( scrapeTests );

		if ( !done ) {
			console.log( "TIMEOUT: QUnit did not complete within " + ( TIMEOUT_MS / 60000 ) +
				" minutes; reporting tests completed so far" );
			report( tests, resultText );
			exitCode = 1;
		} else {
			var summary = report( tests, resultText );
			exitCode = summary.failed === 0 && summary.total > 0 ? 0 : 1;
		}
	} finally {
		await browser.close().catch( function() {} );
	}
	return exitCode;
}

main().then( function( code ) {
	process.exit( code );
}, function( err ) {
	console.error( "Runner error: " + ( err && err.stack ? err.stack : err ) );
	process.exit( 1 );
} );
