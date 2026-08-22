/*
 * pcsc-pipe — cau noi PC/SC toi thieu cho middleware ky so.
 *
 * Doc tung dong lenh tren stdin, tra ket qua tren stdout:
 *   APDU <hex>   -> "OK <resp-hex> <SW4>"   hoac "ERR <ly-do>"
 *   RESET        -> ket noi lai the
 *   ATR          -> "OK <atr-hex>"
 *   QUIT         -> thoat
 *
 * Giu ket noi the mo suot phien, nho vay VERIFY PIN va PSO nam
 * chung mot phien bao mat — dieu kien bat buoc de ky duoc.
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <PCSC/winscard.h>
#include <PCSC/wintypes.h>

static SCARDCONTEXT ctx;
static SCARDHANDLE card;
static DWORD proto;
static char reader_name[256];

static int hex2bin(const char *h, unsigned char *out, size_t max, size_t *n) {
  size_t len = 0;
  for (const char *p = h; *p; ) {
    while (*p == ' ' || *p == ':') p++;
    if (!*p) break;
    if (!isxdigit((unsigned char)p[0]) || !isxdigit((unsigned char)p[1])) return -1;
    if (len >= max) return -1;
    char b[3] = { p[0], p[1], 0 };
    out[len++] = (unsigned char)strtoul(b, NULL, 16);
    p += 2;
  }
  *n = len;
  return 0;
}

static void print_hex(const unsigned char *b, size_t n) {
  for (size_t i = 0; i < n; i++) printf("%02X", b[i]);
}

static int connect_card(void) {
  DWORD len = 0;
  if (SCardListReaders(ctx, NULL, NULL, &len) != SCARD_S_SUCCESS) return -1;
  char *readers = malloc(len);
  if (SCardListReaders(ctx, NULL, readers, &len) != SCARD_S_SUCCESS) { free(readers); return -1; }
  snprintf(reader_name, sizeof reader_name, "%s", readers);
  LONG rv = SCardConnect(ctx, readers, SCARD_SHARE_SHARED,
                         SCARD_PROTOCOL_T0 | SCARD_PROTOCOL_T1, &card, &proto);
  free(readers);
  return rv == SCARD_S_SUCCESS ? 0 : -1;
}

int main(void) {
  setvbuf(stdout, NULL, _IOLBF, 0);

  if (SCardEstablishContext(SCARD_SCOPE_SYSTEM, NULL, NULL, &ctx) != SCARD_S_SUCCESS) {
    printf("ERR khong khoi tao duoc PC/SC\n"); return 1;
  }
  if (connect_card() != 0) {
    printf("ERR khong ket noi duoc token (chua cam hoac dang bi ung dung khac giu)\n");
    return 1;
  }
  printf("READY %s\n", reader_name);

  char line[65536];
  unsigned char req[32768], resp[65536];

  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\r\n")] = 0;

    if (!strcmp(line, "QUIT")) break;

    if (!strcmp(line, "ATR")) {
      unsigned char atr[64]; DWORD atrlen = sizeof atr, state = 0, pr = 0, nlen = 0;
      if (SCardStatus(card, NULL, &nlen, &state, &pr, atr, &atrlen) == SCARD_S_SUCCESS) {
        printf("OK "); print_hex(atr, atrlen); printf("\n");
      } else printf("ERR khong doc duoc ATR\n");
      continue;
    }

    if (!strcmp(line, "RESET")) {
      SCardDisconnect(card, SCARD_RESET_CARD);
      printf(connect_card() == 0 ? "OK\n" : "ERR ket noi lai that bai\n");
      continue;
    }

    if (!strncmp(line, "APDU ", 5)) {
      size_t n = 0;
      if (hex2bin(line + 5, req, sizeof req, &n) != 0 || n < 4) {
        printf("ERR APDU khong hop le\n"); continue;
      }
      SCARD_IO_REQUEST pio;
      pio.dwProtocol = proto;
      pio.cbPciLength = sizeof(SCARD_IO_REQUEST);
      DWORD rl = sizeof resp;
      LONG rv = SCardTransmit(card, &pio, req, n, NULL, resp, &rl);
      if (rv != SCARD_S_SUCCESS) { printf("ERR SCardTransmit 0x%lx\n", (unsigned long)rv); continue; }
      if (rl < 2) { printf("ERR phan hoi qua ngan\n"); continue; }
      printf("OK ");
      print_hex(resp, rl - 2);
      printf(" %02X%02X\n", resp[rl-2], resp[rl-1]);
      continue;
    }

    printf("ERR lenh la: %s\n", line);
  }

  SCardDisconnect(card, SCARD_LEAVE_CARD);
  SCardReleaseContext(ctx);
  return 0;
}
