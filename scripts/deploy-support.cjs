// Additive, backed-up deployment for the Auric support API only.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),auric=path.join(root,'Auric'),auth=path.join(root,'API');
const run=(cwd,args,quiet=false)=>execFileSync('docker',args,{cwd,windowsHide:true,encoding:quiet?'utf8':undefined,stdio:quiet?'pipe':'inherit'});
async function deploy(){
 const adminDirectory=fs.existsSync(path.join(root,'..','UI','Admin','package.json'))?path.join(root,'..','UI','Admin'):path.join(root,'Admin');
 const backups=path.join(adminDirectory,'.runtime','backups');fs.mkdirSync(backups,{recursive:true});
 const name=`before-auric-support-${new Date().toISOString().replace(/[:.]/g,'-')}.dump`;
 run(auth,['compose','exec','-T','db','sh','-c',`pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/${name}`]);
 const container=run(auth,['compose','ps','-q','db'],true).trim();if(!/^[a-f0-9]{12,64}$/i.test(container))throw Error('Could not identify PostgreSQL container.');
 run(root,['cp',`${container}:/tmp/${name}`,path.join(backups,name)]);console.log('Database backup saved: '+path.join(backups,name));
 run(auric,['compose','build','auric']);
 process.loadEnvFile(path.join(auth,'.env'));const {Client}=require('pg');
 const client=new Client({host:'127.0.0.1',port:Number(process.env.POSTGRES_PORT||5432),user:process.env.POSTGRES_USER||'app',database:process.env.POSTGRES_DB||'app',password:process.env.POSTGRES_PASSWORD,connectionTimeoutMillis:5000});
 try{
  await client.connect();await client.query('BEGIN');
  try{await client.query("SELECT pg_advisory_xact_lock(hashtext('auric.schema_migrations'))");const migration=require('../dist/support/support.schema.js').auricSupportSchema;const existing=await client.query('SELECT 1 FROM auric.schema_migrations WHERE id=$1',[migration.id]);if(!existing.rowCount){await client.query(migration.sql);await client.query('INSERT INTO auric.schema_migrations(id) VALUES($1)',[migration.id]);}await client.query('COMMIT');console.log('Auric support migration is ready.');}catch(error){await client.query('ROLLBACK');throw error;}
 }finally{await client.end();}
 run(auric,['compose','up','-d','--no-deps','--no-build','--wait','auric']);
 console.log('Auric support server deployed and healthy. Auth and Cove were not restarted.');
}
deploy().catch(error=>{console.error('Support deployment failed:',error.code||error.message);process.exitCode=1;});
