import {BadRequestException} from '@nestjs/common';
import {createHash} from 'node:crypto';
export const statuses=['open','in_progress','waiting_customer','resolved','closed'];
export const priorities=['low','normal','high','urgent'];
export function supportId(value:unknown){if(typeof value!=='string'||!/^\d{1,15}$/.test(value)||Number(value)<1||!Number.isSafeInteger(Number(value)))throw new BadRequestException('A valid support request ID is required.');return value;}
export function supportText(value:unknown,label:string,max:number,required=true){if(value==null&&!required)return '';if(typeof value!=='string'||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)||required&&!value.trim())throw new BadRequestException(`Provide a valid ${label} (maximum ${max} characters).`);return value.trim();}
export function redact(value:string){return value.replace(/(Bearer\s+)[A-Za-z0-9_.~+/-]+=*/gi,'$1[redacted]').replace(/((?:postgres(?:ql)?|https?):\/\/[^\s:/]+:)[^\s@]+@/gi,'$1[redacted]@').replace(/(["']?(?:[a-z_]*(?:password|token|secret|file_key|db_key)|authorization|cookie)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,'$1[redacted]');}
export function sanitize(value:unknown,depth=0):any {
 if(depth>8)return '[omitted]';if(typeof value==='string')return redact(value.slice(0,12000));
 if(value===null||typeof value==='boolean'||typeof value==='number')return value;
 if(Array.isArray(value))return value.slice(0,100).map(v=>sanitize(v,depth+1));
 if(value&&typeof value==='object'){const result:Record<string,unknown>=Object.create(null);for(const [key,v] of Object.entries(value).slice(0,100)){if(['__proto__','constructor','prototype'].includes(key))continue;result[key]=/password|token|secret|authorization|cookie|private.?key|file.?key|db.?key|encryption.?key|master.?key|api.?key|access.?key|credentials/i.test(key)?'[redacted]':sanitize(v,depth+1);}return result;}
 return null;
}
function boundedJSON(value:unknown,max:number,label:string){let encoded:string;try{encoded=JSON.stringify(value??{});}catch{throw new BadRequestException(`Invalid ${label}.`);}if(Buffer.byteLength(encoded)>max)throw new BadRequestException(`${label} is too large.`);return sanitize(value??{});}
export function screenshot(value:unknown){
 if(!value)return null;if(typeof value!=='string')throw new BadRequestException('Invalid screenshot.');
 const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);if(!match||match[2].length>5592408)throw new BadRequestException('Use a PNG or JPEG screenshot up to 4 MiB.');
 const bytes=Buffer.from(match[2],'base64');if(bytes.length>4194304||bytes.toString('base64')!==match[2])throw new BadRequestException('Invalid screenshot encoding.');
 const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(match[1]==='png'?!png:!jpeg)throw new BadRequestException('Screenshot contents do not match its image type.');
 return {bytes,mime:`image/${match[1]}`};
}
export function supportPayload(raw:any,kind:'request'|'error_report'){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new BadRequestException('Provide a support report.');
 const error=kind==='error_report';const category=error?'bug':raw.category;if(!['bug','help','feedback'].includes(category))throw new BadRequestException('Choose bug, help, or feedback.');
 const subject=supportText(error?raw.title:raw.subject,'subject',200),message=error?supportText(raw.description||raw.title,'description',12000):supportText(raw.message,'message',12000);
 const currentPath=supportText(raw.current_path??raw.currentPath,'current path',1000,false).split('?')[0].split('#')[0],pageTitle=supportText(raw.page_title??raw.pageTitle,'page title',300,false);
 if(!error&&[raw.includeLogs,raw.includeScreenshot].some(v=>v!==undefined&&typeof v!=='boolean'))throw new BadRequestException('Diagnostic options must be true or false.');
 const includeLogs=!error&&raw.includeLogs===true,includeScreenshot=!error&&raw.includeScreenshot===true;
 const image=includeScreenshot?screenshot(raw.screenshotDataUrl):null;
 const diagnostics:any={appContext:boundedJSON(raw.appContext,32768,'App context'),includeLogs,includeScreenshot};
 if(includeLogs){for(const key of ['logEntries','errorEntries']){const entries=raw[key]??[];if(!Array.isArray(entries)||entries.length>100)throw new BadRequestException('Send at most 100 log entries.');diagnostics[key]=boundedJSON(entries,262144,'Diagnostic logs');}}
 if(includeScreenshot)diagnostics.screenshotError=supportText(raw.screenshotError,'screenshot error',1000,false);
 if(error){diagnostics.context=boundedJSON(raw.context,65536,'Error context');diagnostics.variant=supportText(raw.variant,'error variant',100,false);}
 const fingerprint=createHash('sha256').update(JSON.stringify({kind,category,subject,message,currentPath,pageTitle})).digest('hex');
 return {kind,category,subject,message,currentPath,pageTitle,diagnostics,image,fingerprint};
}
