import { BadRequestException } from '@nestjs/common';
export class UpdateVersionDto {
  isLatest?: boolean;
  releaseNotes?: string;

  static fromRaw(body: Record<string, any>): UpdateVersionDto {
    const dto: UpdateVersionDto = {};
    for(const value of [body.isLatest,body.is_latest])if(value!==undefined&&typeof value!=='boolean')throw new BadRequestException('isLatest must be a boolean.');
    if (body.isLatest !== undefined) {
      dto.isLatest = Boolean(body.isLatest);
    } else if (body.is_latest !== undefined) {
      dto.isLatest = Boolean(body.is_latest);
    }

    if (body.releaseNotes !== undefined) {
      dto.releaseNotes = String(body.releaseNotes);
    } else if (body.release_notes !== undefined) {
      dto.releaseNotes = String(body.release_notes);
    }

    if((dto.releaseNotes?.length??0)>32000)throw new BadRequestException('Release notes are too long.');
    return dto;
  }
}
