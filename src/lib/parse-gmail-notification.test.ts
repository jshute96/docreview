// Tests for src/lib/parse-gmail-notification.ts
// Examples: testing/gmail_notifications/*.eml / *.json
// Check script: scripts/check-gmail-notifications.ts
// Skill: /gmail-notification-parser (check, fix, add)

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseGmailNotification, parseCommentTime, headerDateToISO } from "./parse-gmail-notification";
import type { CommentNotification, SharingNotification } from "./parse-gmail-notification";

const EXAMPLES_DIR = join(__dirname, "../../testing/gmail_notifications");

describe("parseGmailNotification", () => {
  describe("comment notification", () => {
    const raw = readFileSync(join(EXAMPLES_DIR, "comment_notification.eml"), "utf-8");
    const result = parseGmailNotification(raw) as CommentNotification;

    it("identifies the type", () => {
      expect(result.type).toBe("comment");
    });

    it("extracts headers", () => {
      expect(result.subject).toBe("shared doc from dave");
      expect(result.from).toContain("comments-noreply@docs.google.com");
      expect(result.to).toBe("docreview.dave@gmail.com");
      expect(result.date_str).toBe("Sat, 07 Mar 2026 10:42:27 -0800");
      expect(result.date).toBe("2026-03-07T18:42:27.000Z");
    });

    it("extracts document info", () => {
      expect(result.documentTitle).toBe("shared doc from dave");
      expect(result.documentId).toBe("1Ah8scE1myNXdXIJKHTAULZueEZrqjZ527sjvvJiKQvk");
      expect(result.documentUrl).toContain("docs.google.com/document/d/1Ah8scE1myNXdXIJKHTAULZueEZrqjZ527sjvvJiKQvk");
    });

    it("extracts x-document-id header", () => {
      expect(result.xDocumentId).toBe("xDgAAAMQ2MeZSGlRUJl5qQr-pVqkrJkYQcl8ytg");
    });

    it("extracts feedback-id header", () => {
      expect(result.feedbackId).toBe("MailTypeComment:EditorsNotification");
    });

    it("extracts recipient user ID", () => {
      expect(result.recipientUserId).toBe("116797062718942056712");
    });

    it("extracts comment threads", () => {
      expect(result.comments).toHaveLength(1);
      const thread = result.comments[0];
      expect(thread.quotedText).toBe("Eawg");
      expect(thread.discussionId).toBe("AAAB1agdt2A");
      expect(thread.openUrl).toContain("disco=AAAB1agdt2A");
      expect(thread.replyTo).toContain("@docs.google.com");
    });

    it("extracts comment replies", () => {
      const replies = result.comments[0].replies;
      expect(replies).toHaveLength(3);

      expect(replies[0].author).toBe("Jeff Shute");
      expect(replies[0].text).toBe("hello");
      expect(replies[0].isNew).toBe(false);

      expect(replies[1].author).toBe("Dave");
      expect(replies[1].text).toBe("abc");
      expect(replies[1].isNew).toBe(false);

      expect(replies[2].author).toBe("Jeff Shute");
      expect(replies[2].text).toBe("def");
      expect(replies[2].isNew).toBe(true);
    });

    it("extracts suggestions with empty replies", () => {
      expect(result.suggestions).toHaveLength(3);

      const s1 = result.suggestions[0];
      expect(s1.action).toBe("Delete");
      expect(s1.text).toContain("Aewg");
      expect(s1.discussionId).toBe("AAAB1agdt2E");
      expect(s1.replyTo).toContain("@docs.google.com");
      expect(s1.replies).toEqual([]);

      const s2 = result.suggestions[1];
      expect(s2.action).toBe("Add");
      expect(s2.text).toContain("ddd");
      expect(s2.discussionId).toBe("AAAB1agdt2I");

      const s3 = result.suggestions[2];
      expect(s3.action).toBe("Replace");
      expect(s3.oldText).toContain("Ga");
      expect(s3.newText).toContain("gew");
      expect(s3.discussionId).toBe("AAAB1agdt2M");
    });

    it("extracts avatar URLs", () => {
      const replies = result.comments[0].replies;
      expect(replies[0].avatarUrl).toContain("lh3.googleusercontent.com");
    });
  });

  describe("comment notification with assigned comments and mentions", () => {
    const raw = readFileSync(join(EXAMPLES_DIR, "comment_notification2.eml"), "utf-8");
    const result = parseGmailNotification(raw) as CommentNotification;

    it("extracts assigned comment (todo_email_discussion)", () => {
      expect(result.comments).toHaveLength(3);
      const assigned = result.comments.find(c => c.assignedTo);
      expect(assigned).toBeDefined();
      expect(assigned!.assignedTo).toBe("you");
      expect(assigned!.discussionId).toBe("AAAB03FPnH8");
    });

    it("preserves spaces around mentions in comment text", () => {
      const mentionComment = result.comments[0].replies[0];
      expect(mentionComment.text).toBe("comment with mentions @jshute@gmail.com @docreview.dave@gmail.com");
    });

    it("preserves spaces across <br> tags", () => {
      const thread = result.comments.find(c => c.discussionId === "AAAB1agdt2A")!;
      const dave = thread.replies.find(r => r.author === "Dave" && r.text.includes("email comment"))!;
      expect(dave.text).toBe("adding an email comment");
    });

    it("extracts suggestion replies", () => {
      expect(result.suggestions).toHaveLength(1);
      const s = result.suggestions[0];
      expect(s.replies).toHaveLength(2);
      expect(s.replies[0].author).toBe("Dave");
      expect(s.replies[0].text).toBe("adding an email comment on a suggesetion");
      expect(s.replies[1].author).toBe("Jeff Shute");
      expect(s.replies[1].isNew).toBe(true);
    });
  });

  describe("comment reply time fields", () => {
    const raw = readFileSync(join(EXAMPLES_DIR, "comment_notification.eml"), "utf-8");
    const result = parseGmailNotification(raw) as CommentNotification;

    it("includes both time_str and time on replies", () => {
      const reply = result.comments[0].replies[0];
      expect(reply.time_str).toBe("6:34\u202fPM, Mar 7 (UTC)");
      expect(reply.time).toBe("2026-03-07T18:34:00.000Z");
    });

    it("includes both time_str and time on suggestions", () => {
      const s = result.suggestions[0];
      expect(s.time_str).toBe("6:35\u202fPM, Mar 7 (UTC)");
      expect(s.time).toBe("2026-03-07T18:35:00.000Z");
    });
  });

  describe("sharing invitation", () => {
    const raw = readFileSync(join(EXAMPLES_DIR, "invitation_to_edit.eml"), "utf-8");
    const result = parseGmailNotification(raw) as SharingNotification;

    it("identifies the type", () => {
      expect(result.type).toBe("sharing");
    });

    it("extracts headers", () => {
      expect(result.subject).toBe('Document shared with you: "Shared from home 1"');
      expect(result.to).toBe("docreview.dave@gmail.com");
      expect(result.date_str).toContain("07 Mar 2026");
      expect(result.date).toBe("2026-03-07T06:38:35.000Z");
    });

    it("extracts sharer info", () => {
      expect(result.sharerName).toBe("Jeff Shute");
      expect(result.sharerEmail).toBe("jshute@gmail.com");
      expect(result.permission).toBe("edit");
    });

    it("extracts document info", () => {
      expect(result.documentTitle).toBe("Shared from home 1");
      expect(result.documentId).toBe("1xMvTIcXaNHyf2HQlKU8lBYhmZ-RJMh7Db-rWgVsgUZk");
      expect(result.documentUrl).toContain("docs.google.com/document/d/1xMvTIcXaNHyf2HQlKU8lBYhmZ-RJMh7Db-rWgVsgUZk");
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests for time/date normalization helpers
// These use direct inputs rather than .eml files since the formatted time
// strings are locale-dependent and may differ across Google account settings.
// ---------------------------------------------------------------------------

describe("parseCommentTime", () => {
  const emailDate = "Sat, 07 Mar 2026 10:42:27 -0800";

  it("parses English-locale AM time", () => {
    expect(parseCommentTime("9:05 AM, Jan 15 (UTC)", emailDate)).toBe("2026-01-15T09:05:00.000Z");
  });

  it("parses English-locale PM time", () => {
    expect(parseCommentTime("6:34 PM, Mar 7 (UTC)", emailDate)).toBe("2026-03-07T18:34:00.000Z");
  });

  it("handles 12:xx AM (midnight hour)", () => {
    expect(parseCommentTime("12:01 AM, Mar 7 (UTC)", emailDate)).toBe("2026-03-07T00:01:00.000Z");
  });

  it("handles 12:xx PM (noon hour)", () => {
    expect(parseCommentTime("12:30 PM, Mar 7 (UTC)", emailDate)).toBe("2026-03-07T12:30:00.000Z");
  });

  it("converts PST timezone to UTC", () => {
    // 6:34 PM PST = 6:34 PM + 8 hours = 2:34 AM next day UTC
    expect(parseCommentTime("6:34 PM, Mar 7 (PST)", emailDate)).toBe("2026-03-08T02:34:00.000Z");
  });

  it("converts EDT timezone to UTC", () => {
    // 6:34 PM EDT = 6:34 PM + 4 hours = 10:34 PM UTC
    expect(parseCommentTime("6:34 PM, Mar 7 (EDT)", emailDate)).toBe("2026-03-07T22:34:00.000Z");
  });

  it("converts GMT+5:30 timezone to UTC", () => {
    // 6:34 PM GMT+5:30 = 6:34 PM - 5:30 = 1:04 PM UTC
    expect(parseCommentTime("6:34 PM, Mar 7 (GMT+5:30)", emailDate)).toBe("2026-03-07T13:04:00.000Z");
  });

  it("converts GMT-8 timezone to UTC", () => {
    // 6:34 PM GMT-8 = 6:34 PM + 8 = 2:34 AM next day UTC
    expect(parseCommentTime("6:34 PM, Mar 7 (GMT-8)", emailDate)).toBe("2026-03-08T02:34:00.000Z");
  });

  it("returns undefined for unknown timezone abbreviation", () => {
    expect(parseCommentTime("6:34 PM, Mar 7 (XYZ)", emailDate)).toBeUndefined();
  });

  it("returns undefined for non-English locale format", () => {
    // German-style: 24-hour, localized month
    expect(parseCommentTime("18:34, 7. März (UTC)", emailDate)).toBeUndefined();
  });

  it("returns undefined for unrecognized format", () => {
    expect(parseCommentTime("March 7, 2026 6:34 PM", emailDate)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseCommentTime("", emailDate)).toBeUndefined();
  });

  it("returns undefined if email date is unparseable (no year available)", () => {
    expect(parseCommentTime("6:34 PM, Mar 7 (UTC)", "not a date")).toBeUndefined();
  });

  it("infers year from the email Date header", () => {
    const emailDate2030 = "Mon, 01 Jul 2030 12:00:00 +0000";
    expect(parseCommentTime("3:00 PM, Jul 1 (UTC)", emailDate2030)).toBe("2030-07-01T15:00:00.000Z");
  });
});

describe("headerDateToISO", () => {
  it("converts RFC 2822 to ISO 8601", () => {
    expect(headerDateToISO("Sat, 07 Mar 2026 10:42:27 -0800")).toBe("2026-03-07T18:42:27.000Z");
  });

  it("handles UTC offset", () => {
    expect(headerDateToISO("Tue, 10 Mar 2026 21:58:01 -0700")).toBe("2026-03-11T04:58:01.000Z");
  });

  it("returns undefined for empty string", () => {
    expect(headerDateToISO("")).toBeUndefined();
  });

  it("returns undefined for unparseable date", () => {
    expect(headerDateToISO("not a date")).toBeUndefined();
  });
});
