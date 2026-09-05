-- KAN-432. User-verified closures in the immutable PT source. These records
-- were never promoted; retain the audit row but remove them from future review.
UPDATE overture_candidate
SET promotion_status = 'rejected', promotion_note = 'user-confirmed closed'
WHERE promotion_status = 'pending' AND overture_id IN (
  'cd8136f6-84fa-49b5-91d8-f3fd2d77147c',
  'a19cd982-3ba3-464c-886f-833a53b6ebc2',
  '209341f8-54ef-4df1-8186-c3753aee3a88'
);
