const FAVICON_LAYOUT = {
  avatar: { size: 24, x: 32, y: 32 },
  canvasSize: 64,
  gradient: { radius: 5, size: 40, x: 12, y: 12 },
} as const;

const DEFAULT_FAVICON_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
const PROFILE_FAVICON_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";
const MAX_AVATAR_BYTES = 1_000_000;
const SUPPORTED_AVATAR_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const GRADIENT_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAQeElEQVR42pVbbbbrxo2sQjcl2fEGZ6+zg+xg1uETj+9lo/ID6C+Kui9JDk1JV48iCgWggG7yn//zf/8r8g+BvzvxFGkO0kmIhF8OGdEuf2tGOA2tf5bfccY5/o54vXzWgPwu4n1+5wTH+5PEN4GzvwbwzcuRn535+iRwLue4LuCAHHAn/wbwl4A/K6E/IPwB4h8En5AKCRCAABAEgXFI828gAAAUQAjx7wgIIDGvoPnd+T+BjCsp/43IeB1vx9Gv5AAUhuwHb15zfl953yIAsFF4CCiEUCn/neA/HPa7AU8HajfaAHjc0n4kQFR/zwkE4/sBAsFhwhUBpoF5VXKBZp6vx08gNNx83v/NvHoDWPO+vJr0EPEw+dPBF8liiZWnJy1vtIPSr6YBhGBgvNcFoLvXC3gdF30ynulN8t3rV6MTmNY/52I8+y2r5U+eBL6qyYvA4rRCoRhQBQ9Tk+sOwvLWHNPrpnmzpNLIoLwl9a6GLwTYvL4ZzwBTn4xez0uMNxCNug+B5RcoFEKFQKmUp28FwCAQDoN1ELZb6zdPQEIPbSMgMQyVBgir9/tP9M92IJaw4E73OJhHeLZBeQ6DGyOhds8HMISY+aUHWtpvECzzVjX5muIgFAB+AcETnEn5Hg5B+2CI1L2eCVHTy28MuCRGfTq4e35UCgYIJzgzPbTRfjUeEmwJV1NYWos8KC6CSbnueY/IzneasaRJKBMjj3cgCEi6MCL+hnwP8r0o5LWH98k0pnu+ez09v1F/xnxbgJuUDxCKwvMFQlG4tJoaqKjjur+tzAEIKByQLQxIZJUX1MgDe04Y1QF8Y0LE+/Raf+2rYduh1AvYqb96Xup3DKa3i8LweB1AVJMPqgiWhT5TtHU3WwZFsEOa+UGdDYqYoybiFEdOgGZC/BQHb7E/Mj1H7J9X2l/jfrnSMH54XagC6gBBqOYNIkEYXAJos1S5MrsrOdDvtCsEg2UyNPUcQEiCJwtMhHcQxr1dauAl5rWWtMXLJ5czMBjgS7LrAPQkV5SGYhivOKszoMVND90n+FWH9TxpIyYgS3rIB3PcATPBlYAwhZQuIbEn/j3hXY3nTHCr0efyuafpWrJ9ZPputPIAjmRA7YwwNUAW9KUtxl/90w3PT7oGkAV4irqhTDSS4CMEtEhq3V35Te2t9D55PTQFELvzNESapXdLGn8M44UjQSidAUWROhwE5CAtsjaDWqBA6wlMIQ9nZcRIB26wsBwS4AoPmJjnzoR3Ubwmva76Zp3Pxmbx/ox5DON7P2IJQN2M1mb8xoDinsmrl8EICMJAlHjtGoqGi/HrWRaZNTyQuWE1fFy3h8Ml/q+Zv8f9hQGdGZ0t1Cx11hNbHkcC8PAFAGCAkyFwArJIWnlzw/MUyIKueRm6ON5v5+y2FNWge1xSJsLF+1pk4eRVKNBF329GZ/bfS90M0/57BTPeD4+W75Dw6Axw4UAPgSyD1RvEkMOSgYyqHzqwpNGWYBhoQvMAhV7QLLqmGctEGV6dYIww6O1xJqthPPbEt/X05Kj/vpTerlxMs8StBofnMd/Hd3gsYmhUgRBDDiqM1WCAgSxwCo0JCMPM3lZ1BiAZIIVCNPcQ1gkE0UuqNjm0qr+1sRkgZAUQJtCWcW9YKO8TgEcC8FhCoYdBlVCTwHsIdDEDTzb0Q6CFLG5eQAqtK5tx++ViUCg6F2HykQyZR1iizAyT+r3URaa3oe+FpflKEHuNPxaP78ZP70/juwbIHFAUlTSM5zBcGQoRDoK7oVEgHZ5MiPI2j/e2NjW9E40OY/QKvRwO46FN30/6a9J+SXQclJ+GrR5/LolvZUBdlWBeK3RAmuBZTQkb+cBoERosw/jWDb8FQFtm73PDMpJjgN1bxz6qWrP+LHNJ+d7MLDE/E930+PPKAiES32o8pJJJMJuhc4ykqK4DLaPUllBwGEuC4XA0kBUGB+VJa02FhCidnsONRqIYl1DAiGrPCtD2AeYw3oaLFs8vhj59P29lTxOAkjK4dL0AoRoCAInZ/PbDUhjbrApDKOW8gI6mAloCgTrZIG3qrpFoTpxGmAyUx4BqZH+Nhsbn5CZudvO8Ty+n11cABu19SXiC6lCHEf8miEMHcDU8elPRoGyTKcv+vo9JGtwnG4IFNZkQB+AAHWAksdaA04DigDlhxjEW7So+okJDLZbu+S5bXTgSgG74Svvn8Lx0LH1AZ40JKpBMoegpqZJtm011zcYEIcLCsqa3nBQZXAVOg1nJytBgKDC1ZIOPrCKEuGotanoPBfo2CIigy+lSTcUd8tZRL4Y+3fW8xP6gu/dSJxRJRWIRZAv1x0iMPAcAzFAgh2gd4TDCIi4DokVoeAFZYGwwVBgbyBaMwDG6e6ejmXB6eLJ4qjFPVhhQPILIqSyqgkmqEg9JD/c0Xni6dzD0yL9Xn21vSc9nqZSF52GQGGAIgjYA+jRnY8IGQPTE3vOC+usSqtFPmBWwVdBqAMEGsEGtwc3RrOHhjsMdR3Mc5qhecbTgDoaSDOrXpPPDFwAu2f5wqY5EJ5Wlzps2r2uKseB8RQIwldnarfMtNLAkxz1BGgwF7pkUVWBeQR5AHu7fONsDTzvxZQe+7YGvduibNQCUoZLynCD12H1IevjwNh7p/cPX2q7hdctSF7ph0j3PUaEDDA0AAC7jKs5JxRsbEhB+qBQooEoAoBKh4AdgB9wPND3Q/IHTHzjbQycfcBygiiorGiOlGiI0LipPW6xrp3sfgixUH5J5mWYnAAFEhZ37aGYZ0XIbW01mbICsQHDK5/h/yZa6IiRIgOB6wP0pbw8AT5gOHX7gm1UNBZCBoPoEJ0uajmW4UWd8Dy/bUIpJ9WUiPIfEmt23sDLgMqe6zKuJHQwuy2V9UVPZUhsJN4tSxwLSABaIB4QD0AH4M41/6vAHXnzoxAFHEYI9KiKqiGOd44mo6OPtKY83w7Vascy6RwiwK7aVATerFTeDe97M8gcgnAdJ0AAawWKAWYJxgDpEf6LggUNPvNpTX3ii6akAqIpeVFSCQ4qaYmIXMbAcqaxrjauxvLtNXadvyiRI3C+B4X1Je15RY7BLKI1WApDttCHGaQXRTZqBVmA8wnh/6KEXvvTCqZeaPyE9BD9EHTBVGQpKqAZYhJqsL8EPCb8745PzLt03PjBgLqLdGT25NNQLQAfZB//xWuaQeQLQ1xkyWbKi6IGqBx7+G872wtlecH9J/gT8Cfoh4lAog6LIJYFoX6fWWFZf/M659D43MKyf7StvFfZ9A8AFqFvDNaTuPDfQHDCP1yVAiPexNmAwFFUWP1T9wdNfau03+PmCny/IX4C/AH8AeoAx50GgWINSMCjoNUqzEghxiXym0dtqDMfyBcA7BmgHgDfnYfRymAMWogelgXbGe3NYsiJiNdRj0YGKB9xfcP9/ePuNOl9Qe0ntBekJ6AnoIHjEDIcVYo3GmAWiSUzBvAAyd5pwZAUNEHKMyvDqJQf44vEbb0PvRjMNH8e5nWkNpM+FFycMFfKKggdcJ+Qn5afk39D5Dfg35F+UvhDS54gKwiMBqBCLAoQSKw80gcmMpTyPRm+EAbMU8FIF1vFW9zL8s8ffDO9Gn0BZgGCLvIDASzDIK8BKQ4sZtJqgRnmDdELthNq3oG8KDwghloRD4kGxSqx5LhQNYiE6CDCJyTnmAI25Vh2eVwciABgx7jcx7vvrjO/Pxp/zs+wDsuLkspgB7hB9WRbr8wMBckoOqUF+Sop9YI5H1xErCIijRPuOgs6CeJ9hwZREtDFfCiCISIJbzPtNgls8fkf5cgGgA9Sv0edejYiamAtlPMlxgzYWt6KIeqxCK87M1QGxxYEKWQKAEQ4QC4DC2GYTAGTS1JIX1EGZDOAdAFev+0hy11h/93z+27HHrd/MElo5NCGc4CnAYh9Fr15UGK8YmwoNUqN4dsGEhQURDpEgBeYsqYNAy3XuWTFAoobHdElw+uz1AcCvjB9ia1lH4/1+sPgtki3X0dedBBqr0ICTcomeLDhAJSNYJhAqBItiqlXY8wJpFA2jUyCRDPA9028ev0t2Nwyw5fu9mowmS8s6OC8t95JvzEm6YI2w775iq5zUdBDirBjHiQ1QDGgDiMgJUA+JJqmANEomLlUCIirK93uZG15fans38up9W+P9Qvtt78tieP986686ExrBbLdtHZftC+iMREmwiczdA6oJSonmK8YjDJCKFCAQJKPhJhcAMiav8W5+4/X2wXjNTT/bFjBejos+51J6Tf03SR8bC2JSp7y4+hjV5yieC/tUO5gg+ypgY0wHLfdDxBbQyAHQfcJb4/qT4db2JKrrUGU9bH9/3StoF6VpjRQFNfZLRd8lvm2pUCXkmkBEGEznjPV8AkYmCJcc8Iu4X4EZ3110g3Cz+e/GePC9T31jAHOvrnNIfPa9EMr9WH1rVrKBNfONR6ML78suEwwZwQAhGfD9g9C5yQH97/Td85eByTTa3j0vvneqvIQCE4hwNiGKJMVz6dm6wBYClLHNIjcqzr2mAUQBYRQGAJxlcFDlGvdXz/u98box3nkT/7x8/9q2L0zwfl9MJjCZ0JjbBCIvUMv6ca4+XzbbTiAKOQa67AAsITDof2HCGh6b1/FDsrNfGM93w+cEc4IQTcSYwZF9v6mkZR7TM7D6kEa5aS86A82Nt0agMKXw+aGtvTlvnv9k9NXwT/TnbeS8hYJpbt607lX2BpPAqZxBiRLjP/mezkGTYEWuO1luxH0LgSsDfNf0vcZf71yfgOB94nubQON9BvGWDxYg4n6ICHomAvPcB0Oy1GGxyhnSuxCaeWDpBfxdBG3t7zIs0SXL48779gMgH+aN2xMV+MF4pL7ve1D2vVfhdlEoseEFCmGkPhqJKTXkqJ8Nzs+w/Ojq+TvD8cF4cB9Fvu8UvDxaopvHTYT5hMY6pMkcMHfGz7xAzVIppX4wRPzHLqibKuDvLfGnafFPca4bIQTeZ3/+ohoI7wmSuaLqWpkQUEoCCnO3LvN5LAoSVAiKVNcBQ8n5MgG6lDlqz+D/9YH7B4M+hsH6aEl/cElzk3Vngq9MiMaB8vXBNkI9T4wNfLn2HCKrRnnTu/G4ZHtcKPzJyx8zPi/Jj/tizOiAl06YV0DW89pA9e2qAGgkXPmcBpQKNWOg64RQgzLWNy3/pu4+GH4b578A4m65gR/C4Uej8f63Mdf0XMH2uSt/7DKLnR+5MBwbJDY9f+f1N8N/MtjuS58+iB/8YPz2lJXmw1p3gIx5y5htMrZqet+z1bmlbnhfv6pjDrBNhu828/+HSu/WcH5cYXtbtbrSHz8ZvxidK1RRiQDl/tQYArtmYrD1GTVUUDFSiXFLe9/Mf5ngvLHALsmO+/Zv8f1xkB+WHPdn6+6evFxCoD+spPU5xHU/vjT289OzlUbTGCvRK+hfAL4A/J2/3za9fm1p8VN542XkxQ+1jv/BIuwnEBY2CPuDiAsbOPvznCAZ4hEOtLCXXwC/KqC/AJTkRwuJdK3zV49eMvobCHifDXy09RffGY/p8WYNc2HE+O4CnPZMHgTxRuBvgP+S+FcF8eeyLvbd9xrcNOv71hndKMJr2OiaAD9Q/rq0TSxU5iXWuT/KDu6PH6yO53rxAYgD+gLwLwJ//hszbBgU9Kg15wAAAABJRU5ErkJggg==";

type FaviconSource = "default" | "fallback" | "profile";

function buildFaviconSvg(avatarDataUrl: string | null): string {
  const { avatar, canvasSize, gradient } = FAVICON_LAYOUT;
  const avatarCenterX = avatar.x + avatar.size / 2;
  const avatarCenterY = avatar.y + avatar.size / 2;
  const avatarMarkup =
    avatarDataUrl === null
      ? ""
      : `<circle cx="${avatarCenterX}" cy="${avatarCenterY}" r="${avatar.size / 2}" fill="#fff"/><image id="avatar" href="${escapeXmlAttribute(avatarDataUrl)}" x="${avatar.x}" y="${avatar.y}" width="${avatar.size}" height="${avatar.size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-clip)"/>`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasSize}" height="${canvasSize}" viewBox="0 0 ${canvasSize} ${canvasSize}">`,
    "<defs>",
    `<clipPath id="gradient-clip"><rect x="${gradient.x}" y="${gradient.y}" width="${gradient.size}" height="${gradient.size}" rx="${gradient.radius}"/></clipPath>`,
    `<clipPath id="avatar-clip"><circle cx="${avatarCenterX}" cy="${avatarCenterY}" r="${avatar.size / 2}"/></clipPath>`,
    "</defs>",
    `<image id="gradient" href="${GRADIENT_PNG_DATA_URL}" x="${gradient.x}" y="${gradient.y}" width="${gradient.size}" height="${gradient.size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#gradient-clip)"/>`,
    avatarMarkup,
    "</svg>",
  ].join("");
}

async function responseImageDataUrl(response: Response): Promise<string | null> {
  if (!response.ok) {
    return null;
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === undefined || !SUPPORTED_AVATAR_TYPES.has(contentType)) {
    return null;
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_AVATAR_BYTES) {
    return null;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) {
    return null;
  }

  return `data:${contentType};base64,${bytesToBase64(bytes)}`;
}

function faviconSvgResponse(svg: string, cacheControl: string, source: FaviconSource): Response {
  return new Response(svg, {
    headers: {
      "cache-control": cacheControl,
      "content-security-policy": "default-src 'none'; img-src data:",
      "content-type": "image/svg+xml; charset=utf-8",
      "x-favicon-source": source,
    },
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export {
  buildFaviconSvg,
  DEFAULT_FAVICON_CACHE_CONTROL,
  FAVICON_LAYOUT,
  faviconSvgResponse,
  PROFILE_FAVICON_CACHE_CONTROL,
  responseImageDataUrl,
};

export type { FaviconSource };
