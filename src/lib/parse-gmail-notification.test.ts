// Tests for src/lib/parse-gmail-notification.ts
// Examples: testing/gmail_notifications/*.eml / *.json
// Check script: scripts/check-gmail-notifications.ts
// Skill: /gmail-notification-parser (check, fix, add)

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseGmailNotification } from "./parse-gmail-notification";
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
      expect(result.date).toContain("07 Mar 2026");
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

  describe("sharing invitation", () => {
    const raw = readFileSync(join(EXAMPLES_DIR, "invitation_to_edit.eml"), "utf-8");
    const result = parseGmailNotification(raw) as SharingNotification;

    it("identifies the type", () => {
      expect(result.type).toBe("sharing");
    });

    it("extracts headers", () => {
      expect(result.subject).toBe('Document shared with you: "Shared from home 1"');
      expect(result.to).toBe("docreview.dave@gmail.com");
      expect(result.date).toContain("07 Mar 2026");
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
