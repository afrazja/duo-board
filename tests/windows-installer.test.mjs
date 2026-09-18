import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const source = fileURLToPath(new URL('../companion/windows/', import.meta.url));
test('Windows startup health rejects stale state, dead processes and revoked connections', { skip: process.platform !== 'win32' }, async t => {
  const root=await mkdtemp(path.join(tmpdir(),'duo-health-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const fixture=fileURLToPath(new URL('./fixtures/windows-health.ps1',import.meta.url));
  const result=await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fixture],{env:{...process.env,DUO_TEST_ROOT:root},timeout:15000});
  assert.equal((result.stdout.match(/PASS:/g)??[]).length,7,result.stdout);
});

// Exercise the real installer orchestration with OS integration stubs. These
// fixtures never register a real task, touch the clipboard, or use credentials.
const mocks = `
function Record([string]$value){Add-Content -LiteralPath (Join-Path $env:DUO_TEST_ROOT 'events.txt') -Value $value}
function Get-Clipboard {if($env:DUO_TEST_SCENARIO -in @('fresh','pair-failure')){return ('duo_pair_'+('x'*43))};return 'ordinary clipboard text'}
function Set-Clipboard {param($Value);Record 'clear-clipboard'}
function Get-Command {param($Name,$ErrorAction);if($Name -eq 'node.exe'){return @{Source=$env:DUO_TEST_NODE}};if($Name -eq 'claude.exe'){return $null};return Microsoft.PowerShell.Core\\Get-Command $Name -ErrorAction SilentlyContinue}
function Get-ScheduledTask {
  param($TaskName,$ErrorAction)
  if($env:DUO_TEST_SCENARIO -eq 'unrelated'){return @{Description='Unrelated application'}}
  if(Test-Path (Join-Path $env:DUO_TEST_ROOT 'task.txt')){return @{Description=('Duo Board Windows companion: '+(Join-Path $env:LOCALAPPDATA 'DuoBoard\\Helper\\state'))}}
}
function Stop-ScheduledTask {param($TaskName,$ErrorAction);Record 'stop-task'}
function New-ScheduledTaskAction {param($Execute,$Argument,$WorkingDirectory);return @{Arguments=$Argument}}
function New-ScheduledTaskTrigger {param([switch]$AtLogOn,$User);return @{User=$User}}
function New-ScheduledTaskPrincipal {param($UserId,$LogonType,$RunLevel);return @{User=$UserId}}
function New-ScheduledTaskSettingsSet {param([switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,[switch]$StartWhenAvailable,$MultipleInstances,$ExecutionTimeLimit,$RestartCount,$RestartInterval);return @{Ready=$true}}
function Register-ScheduledTask {
  param($TaskName,$TaskPath,$Description,$Action,$Trigger,$Principal,$Settings,[switch]$Force)
  if($env:DUO_TEST_SCENARIO -eq 'registration-failure'){throw 'Access denied by Windows policy'}
  Set-Content -LiteralPath (Join-Path $env:DUO_TEST_ROOT 'task.txt') -Value $Action.Arguments;Record 'register-task'
}
function Start-ScheduledTask {param($TaskName,$ErrorAction);Record 'start-task'}
function New-RepairShortcut {param($application);Record 'repair-shortcut'}
function Wait-HelperReady {param($stateDirectory,$application,$since);Record 'health-check';if($env:DUO_TEST_SCENARIO -eq 'reconnect'){return 'reconnect'};if($env:DUO_TEST_SCENARIO -eq 'offline'){return 'offline'};return 'connected'}
`;

for (const scenario of ['fresh','repair','unrelated','registration-failure','pair-failure','reconnect','offline']) {
  test(`Windows installer: ${scenario}`, { skip: process.platform !== 'win32' }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'duo-setup-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const pkg = path.join(root, 'package'); await mkdir(pkg);
    for(const name of ['install.ps1','launch.vbs','run-background.ps1']) await copyFile(path.join(source,name),path.join(pkg,name));
    await writeFile(path.join(pkg,'setup-functions.ps1'),(await readFile(path.join(source,'setup-functions.ps1'),'utf8')) + mocks);
    for(const name of ['background.cjs','helper.cjs']) await writeFile(path.join(pkg,name),'// fixture');
    await writeFile(path.join(pkg,'pair.cjs'),`const fs=require('node:fs'),path=require('node:path');fs.appendFileSync(path.join(process.env.DUO_TEST_ROOT,'events.txt'),'pair\\n');if(process.env.DUO_TEST_SCENARIO==='pair-failure')process.exit(1);const dir=process.argv[process.argv.indexOf('--state-dir')+1];fs.writeFileSync(path.join(dir,'connection.json'),JSON.stringify({sentinel:'paired'}));`);
    const local = path.join(root,'local'), state=path.join(local,'DuoBoard','Helper','state');
    await mkdir(state,{recursive:true});
    if(!['fresh','pair-failure'].includes(scenario)) await writeFile(path.join(state,'connection.json'),'original connection');
    const bin=path.join(local,'OpenAI','Codex','bin','new-version');await mkdir(bin,{recursive:true});await writeFile(path.join(bin,'codex.exe'),'fixture');
    const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(pkg,'install.ps1'),'-NoUI'];
    if(scenario==='repair')args.push('-Repair');
    let output, failed=false;
    try {output=await exec('powershell.exe',args,{env:{...process.env,LOCALAPPDATA:local,DUO_TEST_ROOT:root,DUO_TEST_NODE:process.execPath,DUO_TEST_SCENARIO:scenario},timeout:15000});}
    catch(error){failed=true;output=error;}
    const text=output.stdout+output.stderr;
    const events=await readFile(path.join(root,'events.txt'),'utf8').catch(()=> '');
    assert.equal(failed,!['fresh','repair'].includes(scenario),text);
    if(['fresh','repair'].includes(scenario)){
      assert.match(text,/Automatic startup is verified/);assert.match(events,/register-task[\s\S]*repair-shortcut[\s\S]*start-task[\s\S]*health-check/);
      if(scenario==='fresh')assert.ok(events.indexOf('register-task')<events.indexOf('pair\n'));
      else {assert.equal(await readFile(path.join(state,'connection.json'),'utf8'),'original connection');assert.doesNotMatch(events,/clear-clipboard|^pair$/m);}
    } else {
      assert.doesNotMatch(text,/Automatic startup is verified/);
      if(scenario==='unrelated')assert.equal(events,'');
      if(scenario==='pair-failure')assert.match(events,/register-task[\s\S]*pair[\s\S]*start-task/);
      const log=await readFile(path.join(local,'DuoBoard','Helper','setup.log'),'utf8');assert.match(log,/FAILED at/);assert.doesNotMatch(log,/duo_pair_/);
    }
  });
}
